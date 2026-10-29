import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertSnapshotUnchanged } from "./git.ts";
import type { StagedSnapshot } from "./git.ts";
import { validateCommitMessage } from "./message.ts";

export class CommitError extends Error {}
const executeFile = promisify(execFile);

export async function commitCandidate(
  message: string,
  snapshot: StagedSnapshot,
  {
    cwd = process.cwd(),
    env = process.env,
    temporaryDirectory = tmpdir(),
    onOutput,
    outputIsTTY = process.stdout.isTTY === true,
  }: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    temporaryDirectory?: string;
    onOutput?: (chunk: string) => void;
    outputIsTTY?: boolean;
  } = {},
): Promise<void> {
  const validated = validateCommitMessage(message).message;
  const directory = await mkdtemp(join(temporaryDirectory, "git-scrivener-commit-"));
  try {
    await chmod(directory, 0o700);
    const file = join(directory, "COMMIT_EDITMSG");
    await writeFile(file, `${validated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const commitEnv = { ...env };
    delete commitEnv.OPENAI_API_KEY;
    // The renderer's destination is a terminal, but the hook sees our output pipe.
    // Restore automatic color for hook managers without changing explicit preferences.
    if (
      onOutput &&
      outputIsTTY &&
      env.TERM !== "dumb" &&
      !env.NO_COLOR &&
      env.FORCE_COLOR !== "0"
    ) {
      for (const variable of ["PRE_COMMIT_COLOR", "PREK_COLOR"]) {
        if (commitEnv[variable] === undefined || commitEnv[variable] === "auto") {
          commitEnv[variable] = "always";
        }
      }
    }
    let shell: string | undefined;
    if (onOutput) {
      try {
        const result = await executeFile("git", ["var", "GIT_SHELL_PATH"], {
          cwd,
          env: commitEnv,
          encoding: "utf8",
          maxBuffer: 64 * 1024,
          timeout: 30_000,
        });
        shell = result.stdout.replace(/\n$/, "");
      } catch {
        throw new CommitError("Could not resolve Git's POSIX shell.");
      }
      if (!shell.trim()) throw new CommitError("Git did not provide a POSIX shell.");
    }
    await assertSnapshotUnchanged(snapshot, { cwd, env });
    const ignoreInterrupt = () => {};
    process.on("SIGINT", ignoreInterrupt);
    process.on("SIGQUIT", ignoreInterrupt);
    try {
      await new Promise<void>((resolve, reject) => {
        const args = ["commit", "--file", file];
        // Merge both output descriptors into one pipe before Git starts, preserving write order.
        // The shell program is constant; all Git arguments, including the filename, stay in argv.
        const child = spawn(
          shell ?? "git",
          shell ? ["-c", 'exec git "$@" 2>&1', "git", ...args] : args,
          {
            cwd,
            env: commitEnv,
            // Do not intercept input or create a new session: /dev/tty remains available for signing.
            stdio: ["inherit", onOutput ? "pipe" : "inherit", "inherit"],
          },
        );
        let outputFailed = false;
        if (onOutput && child.stdout) {
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", onOutput);
          child.stdout.once("error", () => {
            outputFailed = true;
          });
        }
        child.once("error", () => reject(new CommitError("Could not start git commit.")));
        child.once("close", (code, signal) => {
          if (outputFailed) {
            reject(
              new CommitError("Could not read Git's output. Check git status before trying again."),
            );
          } else if (code === 0 && signal === null) resolve();
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
