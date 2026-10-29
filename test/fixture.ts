import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export function fixture(t: TestContext, initialize = true) {
  const parent = fileURLToPath(new URL("../.test-tmp/", import.meta.url));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const cwd = mkdtempSync(join(parent, "repo-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // A pre-commit hook may inherit GIT_INDEX_FILE pointing at the user's index.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("GIT_") && key !== "OPENAI_API_KEY",
    ),
  );
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CEILING_DIRECTORIES = parent;
  env.GIT_TERMINAL_PROMPT = "0";

  function git(args: string[], options: { input?: string; status?: number } = {}) {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8", input: options.input });
    assert.ifError(result.error);
    assert.equal(result.status, options.status ?? 0, result.stderr);
    return result.stdout;
  }

  function write(name: string, content: string | Buffer) {
    writeFileSync(join(cwd, name), content);
  }

  if (initialize) {
    git(["init", "--initial-branch=main", "--template="]);
    git(["config", "user.name", "Scrivener Test"]);
    git(["config", "user.email", "scrivener@example.invalid"]);
    git(["config", "commit.gpgsign", "false"]);
    const hooks = join(cwd, "empty-hooks");
    mkdirSync(hooks);
    git(["config", "core.hooksPath", hooks]);
  }

  return { cwd, env, git, write };
}
