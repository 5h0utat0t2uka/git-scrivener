import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { assertSnapshotUnchanged } from "./git.ts";
import type { StagedSnapshot } from "./git.ts";
import { validateCommitMessage } from "./message.ts";

export class CommitError extends Error {}

export async function commitCandidate(
  message: string,
  snapshot: StagedSnapshot,
  {
    cwd = process.cwd(),
    env = process.env,
    temporaryDirectory = tmpdir(),
    onOutputLine,
  }: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    temporaryDirectory?: string;
    onOutputLine?: (line: string) => void;
  } = {},
): Promise<void> {
  const validated = validateCommitMessage(message).message;
  const directory = await mkdtemp(join(temporaryDirectory, "git-scrivener-commit-"));
  try {
    await chmod(directory, 0o700);
    const file = join(directory, "COMMIT_EDITMSG");
    await writeFile(file, `${validated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await assertSnapshotUnchanged(snapshot, { cwd, env });
    const commitEnv = { ...env };
    delete commitEnv.OPENAI_API_KEY;
    const ignoreInterrupt = () => {};
    process.on("SIGINT", ignoreInterrupt);
    process.on("SIGQUIT", ignoreInterrupt);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("git", ["commit", "--file", file], {
          cwd,
          env: commitEnv,
          // Keep input and diagnostics attached to the terminal for hooks and signing.
          stdio: ["inherit", onOutputLine ? "pipe" : "inherit", "inherit"],
        });
        const lines =
          onOutputLine && child.stdout
            ? createInterface({ input: child.stdout, terminal: false, crlfDelay: Infinity })
            : undefined;
        if (lines && onOutputLine) lines.on("line", onOutputLine);
        child.once("error", () => reject(new CommitError("Could not start git commit.")));
        child.once("close", (code, signal) => {
          lines?.close();
          if (code === 0 && signal === null) resolve();
          else
            reject(new CommitError("Git commit failed. Review Git's output before trying again."));
        });
      });
    } finally {
      process.off("SIGINT", ignoreInterrupt);
      process.off("SIGQUIT", ignoreInterrupt);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
