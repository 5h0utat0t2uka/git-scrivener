import { isUtf8 } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAX_MESSAGE_BYTES, MessageValidationError, validateCommitMessage } from "./message.ts";

const executeFile = promisify(execFile);
export class EditorError extends Error {}

export async function editMessage(
  message: string,
  {
    cwd = process.cwd(),
    env = process.env,
    temporaryDirectory = tmpdir(),
  }: { cwd?: string; env?: NodeJS.ProcessEnv; temporaryDirectory?: string } = {},
): Promise<string> {
  const original = validateCommitMessage(message).message;
  const editorEnv = { ...env };
  delete editorEnv.OPENAI_API_KEY;
  delete editorEnv.ANTHROPIC_API_KEY;
  let directory: string | undefined;
  try {
    const { stdout } = await executeFile("git", ["var", "GIT_EDITOR"], {
      cwd,
      env: editorEnv,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
    const editor = stdout.replace(/\n$/, "");
    if (!editor.trim()) throw new EditorError("Git did not provide an editor.");
    const { stdout: shellOutput } = await executeFile("git", ["var", "GIT_SHELL_PATH"], {
      cwd,
      env: editorEnv,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
    const shell = shellOutput.replace(/\n$/, "");
    if (!shell.trim()) throw new EditorError("Git did not provide a POSIX shell.");
    directory = await mkdtemp(join(temporaryDirectory, "git-scrivener-edit-"));
    await chmod(directory, 0o700);
    const file = join(directory, "COMMIT_EDITMSG");
    await writeFile(file, `${original}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });

    // Git's editor is a shell command; the filename stays a positional argument.
    const ignoreInterrupt = () => {};
    process.on("SIGINT", ignoreInterrupt);
    process.on("SIGQUIT", ignoreInterrupt);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(shell, ["-c", `${editor} "$@"`, editor, file], {
          cwd,
          env: editorEnv,
          stdio: "inherit",
        });
        child.once("error", () => reject(new EditorError("Could not start the Git editor.")));
        child.once("close", (code, signal) => {
          if (code === 0 && signal === null) resolve();
          else
            reject(
              new EditorError(
                "The editor did not exit successfully. The previous candidate is retained.",
              ),
            );
        });
      });
    } finally {
      process.off("SIGINT", ignoreInterrupt);
      process.off("SIGQUIT", ignoreInterrupt);
    }

    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new EditorError(
          "The edited message must be a regular file without other hard links.",
        );
      }
      await handle.chmod(0o600);
      const buffer = Buffer.alloc(MAX_MESSAGE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_MESSAGE_BYTES) {
        throw new EditorError("The edited message exceeds the 65536-byte safety limit.");
      }
      const content = buffer.subarray(0, length);
      if (!isUtf8(content)) throw new EditorError("The edited message must use UTF-8 text.");
      return validateCommitMessage(content.toString("utf8")).message;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof EditorError || error instanceof MessageValidationError) throw error;
    throw new EditorError(
      "Could not edit or safely read the message. The previous candidate is retained.",
    );
  } finally {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}
