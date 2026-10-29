import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";

export const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024;

export class RepositoryError extends Error {}

interface GitContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface StagedSnapshot {
  head: string | null;
  headRef: string | null;
  tree: string;
  diff: string;
  diffBytes: number;
  files: Buffer[];
}

interface GitOptions {
  allowExitOne?: boolean;
  maxBuffer?: number;
  overflowMessage?: string;
}

function runGit(args: string[], context: GitContext, options: GitOptions = {}) {
  return new Promise<{ code: number; stdout: Buffer }>((resolve, reject) => {
    execFile(
      "git",
      ["--no-pager", ...args],
      {
        cwd: context.cwd,
        env: { ...context.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        encoding: "buffer",
        maxBuffer: options.maxBuffer ?? 64 * 1024,
        timeout: 30_000,
      },
      (error, stdout) => {
        if (error === null || (options.allowExitOne && error.code === 1 && !error.killed)) {
          resolve({ code: error === null ? 0 : 1, stdout });
          return;
        }

        let message = `Git ${args[0]} failed. Run git status to inspect the repository.`;
        if (error.code === "ENOENT") {
          message = "Git was not found on PATH.";
        } else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          message = options.overflowMessage ?? "Git output exceeded the inspection limit.";
        } else if (error.killed) {
          message = "Git did not finish within 30 seconds.";
        }
        // Git's stderr can contain file contents and terminal control characters.
        reject(new RepositoryError(message));
      },
    );
  });
}

async function readState(context: GitContext) {
  const unmerged = await runGit(["ls-files", "--unmerged", "-z", "--", ":/"], context, {
    overflowMessage: "Resolve all unmerged paths before generating a commit message.",
  });
  if (unmerged.stdout.length !== 0) {
    throw new RepositoryError("Resolve all unmerged paths before generating a commit message.");
  }

  const symbolic = await runGit(["symbolic-ref", "--quiet", "HEAD"], context, {
    allowExitOne: true,
  });
  const headRef = symbolic.code === 0 ? symbolic.stdout.toString("utf8").trim() : null;
  const resolved = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], context, {
    allowExitOne: true,
  });
  const head = resolved.code === 0 ? resolved.stdout.toString("utf8").trim() : null;
  if (head === null) {
    // Only a missing branch ref is an unborn HEAD; do not conceal a broken HEAD.
    if (headRef === null) {
      throw new RepositoryError("HEAD does not resolve to a commit or an unborn branch.");
    }
    const branch = await runGit(["show-ref", "--verify", "--quiet", headRef], context, {
      allowExitOne: true,
    });
    if (branch.code !== 1) {
      throw new RepositoryError("HEAD does not resolve to a commit or an unborn branch.");
    }
  }

  const tree = (await runGit(["write-tree"], context)).stdout.toString("utf8").trim();
  return { head, headRef, tree };
}

export async function readStagedSnapshot({
  cwd = process.cwd(),
  env = process.env,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
}: Partial<GitContext> & { maxDiffBytes?: number } = {}): Promise<StagedSnapshot> {
  if (!Number.isSafeInteger(maxDiffBytes) || maxDiffBytes <= 0) {
    throw new RepositoryError("The diff limit must be a positive integer number of bytes.");
  }

  const context = { cwd, env };
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], context);
  if (inside.stdout.toString("utf8").trim() !== "true") {
    throw new RepositoryError("Run git scrivener inside a Git working tree.");
  }

  const before = await readState(context);
  const result = await runGit(
    [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-relative",
      "--ignore-submodules=none",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--unified=3",
      ...(before.head === null ? [] : [before.head]),
      "--",
    ],
    context,
    {
      maxBuffer: maxDiffBytes,
      overflowMessage: `The staged diff exceeds the ${maxDiffBytes}-byte limit. Stage a smaller change or explicitly increase --max-diff-bytes.`,
    },
  );
  const names = await runGit(
    [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-relative",
      "--ignore-submodules=none",
      ...(before.head === null ? [] : [before.head]),
      "--",
    ],
    context,
    { maxBuffer: maxDiffBytes },
  );
  const after = await readState(context);
  if (
    before.head !== after.head ||
    before.headRef !== after.headRef ||
    before.tree !== after.tree
  ) {
    throw new RepositoryError("HEAD or staged contents changed while reading the diff. Try again.");
  }
  if (result.stdout.length === 0) {
    throw new RepositoryError("No staged changes. Stage the intended changes with git add first.");
  }
  if (!isUtf8(result.stdout)) {
    throw new RepositoryError("The staged diff contains non-UTF-8 text and cannot be processed.");
  }

  // Git paths are byte sequences. Keep them intact until the UI escapes them.
  const files: Buffer[] = [];
  let start = 0;
  for (let end = names.stdout.indexOf(0); end !== -1; end = names.stdout.indexOf(0, start)) {
    files.push(names.stdout.subarray(start, end));
    start = end + 1;
  }
  return {
    ...before,
    diff: result.stdout.toString("utf8"),
    diffBytes: result.stdout.length,
    files,
  };
}

export async function assertSnapshotUnchanged(
  snapshot: Pick<StagedSnapshot, "head" | "headRef" | "tree">,
  { cwd = process.cwd(), env = process.env }: Partial<GitContext> = {},
): Promise<void> {
  const current = await readState({ cwd, env });
  if (
    snapshot.head !== current.head ||
    snapshot.headRef !== current.headRef ||
    snapshot.tree !== current.tree
  ) {
    throw new RepositoryError(
      "HEAD, branch, or staged contents changed. Run git scrivener again to review the new diff.",
    );
  }
}
