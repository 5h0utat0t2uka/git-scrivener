import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./fixture.ts";

const cli = process.env.SCRIVENER_TEST_CLI
  ? resolve(process.env.SCRIVENER_TEST_CLI)
  : fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("help works outside Git without an API key", (t) => {
  const { cwd, env } = fixture(t, false);
  const result = spawnSync(process.execPath, [cli, "--help"], { cwd, env, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: git scrivener/);
  assert.match(result.stdout, /--provider/);
  assert.match(result.stdout, /--language/);
  assert.match(result.stdout, /--plain/);
  assert.match(result.stdout, /ANTHROPIC_API_KEY/);
  assert.match(result.stdout, /claude-haiku-5-5/);
});

test("version works outside Git without an API key", (t) => {
  const { cwd, env } = fixture(t, false);
  const result = spawnSync(process.execPath, [cli, "--version"], { cwd, env, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("rejects invalid arguments without echoing their contents", (t) => {
  const { cwd, env } = fixture(t, false);
  for (const args of [
    ["--unexpected=PRIVATE_INPUT"],
    ["--provider", "PRIVATE_INPUT"],
    ["--language", "PRIVATE_INPUT"],
    ["--model", " PRIVATE_INPUT "],
    ["--max-diff-bytes", "0"],
    ["--max-diff-bytes", "1.5"],
    ["--max-diff-bytes", "9007199254740992"],
    ["unexpected-positional"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /PRIVATE_INPUT|unexpected-positional/);
    assert.equal(result.stdout, "");
  }
});

test("reports no staged changes with a failing exit code", (t) => {
  const { cwd, env } = fixture(t);
  const result = spawnSync(process.execPath, [cli, "--check"], { cwd, env, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No staged changes/);
});

test("rejects noninteractive generation before contacting the API", (t) => {
  const repo = fixture(t, false);
  const result = spawnSync(process.execPath, [cli], {
    cwd: repo.cwd,
    env: { ...repo.env, OPENAI_API_KEY: "test-api-key" },
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive terminal is required/);
});

test("Anthropic requires only its selected key and still requires an interactive terminal in plain mode", (t) => {
  const repo = fixture(t, false);
  const args = [cli, "--provider", "anthropic", "--language", "ja", "--plain"];
  for (const scenario of [
    { env: { OPENAI_API_KEY: "unused-test-key" }, error: /ANTHROPIC_API_KEY is not set/ },
    { env: { ANTHROPIC_API_KEY: "test-api-key" }, error: /interactive terminal is required/ },
  ]) {
    const result = spawnSync(process.execPath, args, {
      cwd: repo.cwd,
      env: { ...repo.env, ...scenario.env },
      encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, scenario.error);
    assert.doesNotMatch(result.stderr, /test-key|test-api-key/);
  }
});

test("--check inspects staged changes without printing the patch or creating a commit", (t) => {
  const repo = fixture(t);
  repo.write("file.txt", "PRIVATE_STAGED_CONTENT\n");
  repo.git(["add", "file.txt"]);
  const index = repo.git(["ls-files", "--stage", "-z"]);
  const result = spawnSync(
    process.execPath,
    [cli, "--check", "--provider", "anthropic", "--model", "claude-test-model", "--language", "ja"],
    {
      cwd: repo.cwd,
      env: repo.env,
      encoding: "utf8",
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Staged diff ready/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_STAGED_CONTENT/);
  assert.equal(repo.git(["ls-files", "--stage", "-z"]), index);
  repo.git(["rev-parse", "--verify", "--quiet", "HEAD"], { status: 1 });
});

test("generation requires a runtime API key and leaves the index unchanged when it is missing", (t) => {
  const repo = fixture(t);
  repo.write("file.txt", "staged content\n");
  repo.git(["add", "file.txt"]);
  const index = repo.git(["ls-files", "--stage", "-z"]);
  const result = spawnSync(process.execPath, [cli], {
    cwd: repo.cwd,
    env: repo.env,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENAI_API_KEY is not set/);
  assert.equal(repo.git(["ls-files", "--stage", "-z"]), index);
});
