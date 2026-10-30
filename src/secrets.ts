import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class SecretScanError extends Error {}

export async function assertNoSecrets(
  text: string,
  {
    env = process.env,
    temporaryDirectory = tmpdir(),
  }: {
    env?: NodeJS.ProcessEnv;
    temporaryDirectory?: string;
  } = {},
): Promise<void> {
  const directory = await mkdtemp(join(temporaryDirectory, "git-scrivener-scan-"));
  try {
    // Ignore target-repository policy and never give the scanner our API credentials.
    const scanEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) => !/^(?:BETTERLEAKS_|GITLEAKS_|OPENAI_|ANTHROPIC_)/.test(key),
      ),
    );
    scanEnv.BETTERLEAKS_CONFIG_TOML = "[extend]\nuseDefault = true\n";

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "betterleaks",
        [
          "stdin",
          "--no-banner",
          "--no-color",
          "--redact=100",
          "--log-level=error",
          "--exit-code=42",
          "--ignore-gitleaks-allow",
          "--gitleaks-ignore-path=/dev/null",
          "--validation=false",
          "--max-target-megabytes=0",
          "--timeout=30",
        ],
        {
          cwd: directory,
          env: scanEnv,
          stdio: ["pipe", "ignore", "ignore"],
          // Unlike spawn's timeout, this does not keep Node alive after an ENOENT error.
          signal: AbortSignal.timeout(35_000),
          killSignal: "SIGKILL",
        },
      );
      let inputFailed = false;
      child.stdin.on("error", () => {
        inputFailed = true;
      });
      child.once("error", () => {
        reject(new SecretScanError("Could not run Betterleaks. No request was made."));
      });
      child.once("close", (code, signal) => {
        if (code === 42) {
          reject(
            new SecretScanError(
              "Potential secrets detected in the data to send. No request was made.",
            ),
          );
        } else if (code !== 0 || signal !== null || inputFailed) {
          reject(
            new SecretScanError(
              "The secret scan did not complete successfully. No request was made.",
            ),
          );
        } else {
          resolve();
        }
      });
      child.stdin.end(text, "utf8");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
