import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  assert.match(result.stdout, /--allow-secret/);
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
    ["--allow-secret", "PRIVATE_INPUT"],
    ["--allow-secret", "rule:../PRIVATE_INPUT"],
    ["--allow-secret"],
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

for (const provider of ["openai", "anthropic"] as const) {
  for (const action of [
    "abort",
    "continue",
    "changed-index",
    "changed-branch",
    "regenerate-abort",
    "allow",
  ] as const) {
    test(
      `${provider} secret review: ${action} preserves explicit per-request approval`,
      { timeout: 20_000 },
      async (t) => {
        const repo = fixture(t);
        const token = "ghp_" + "aB3dE5gH7jK9mN2pQ4sT6vW8xY0zA1bC3dE5";
        repo.write("file.txt", `${token}\n`);
        repo.write("other.txt", `${token}\n`);
        repo.git(["add", "file.txt", "other.txt"]);
        repo.write("file.txt", "later working-tree content\n");
        let expectedIndex = repo.git(["ls-files", "--stage", "-z"]);
        const requestsPath = join(repo.cwd, "requests.json");
        const requests = (): {
          body: { input?: { content: string }[]; messages?: { content: string }[] };
        }[] => (existsSync(requestsPath) ? JSON.parse(readFileSync(requestsPath, "utf8")) : []);
        const child = spawn(
          process.execPath,
          [
            "--import",
            fileURLToPath(new URL("./bundle-preload.ts", import.meta.url)),
            cli,
            "--plain",
            "--provider",
            provider,
            ...(action === "allow"
              ? ["--allow-secret", "github-pat:file.txt", "--allow-secret", "github-pat:other.txt"]
              : []),
          ],
          {
            cwd: repo.cwd,
            env: {
              ...repo.env,
              TMPDIR: repo.cwd,
              OPENAI_API_KEY: "test-openai-key",
              ANTHROPIC_API_KEY: "test-anthropic-key",
            },
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 15_000,
          },
        );
        t.after(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        });
        let output = "";
        let errorOutput = "";
        let unhandledOutput = "";
        let secretPrompts = 0;
        let reviewPrompts = 0;
        let interactionError: unknown;
        child.stderr.on("data", (chunk: Buffer) => {
          errorOutput += chunk.toString();
        });
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          unhandledOutput += chunk.toString();
          try {
            let prompt;
            while ((prompt = /default: (abort|cancel)\): /.exec(unhandledOutput))) {
              unhandledOutput = unhandledOutput.slice(prompt.index + prompt[0].length);
              if (prompt[1] === "abort") {
                secretPrompts++;
                assert.equal(
                  requests().length,
                  secretPrompts - 1,
                  "no request before this approval",
                );
                if (action === "changed-index") {
                  repo.write("other.txt", "new staged content\n");
                  repo.git(["add", "other.txt"]);
                  expectedIndex = repo.git(["ls-files", "--stage", "-z"]);
                }
                if (action === "changed-branch")
                  repo.git(["symbolic-ref", "HEAD", "refs/heads/changed"]);
                const answer = action === "abort" || secretPrompts > 1 ? "\n" : "c\n";
                if (
                  action === "abort" ||
                  action === "changed-index" ||
                  action === "changed-branch" ||
                  secretPrompts > 1
                ) {
                  // This is the final answer: the test's input producer must send EOF.
                  child.stdin.end(answer);
                } else child.stdin.write(answer);
              } else {
                reviewPrompts++;
                assert.equal(requests().length, 1);
                if (action === "regenerate-abort") child.stdin.write("r\n");
                else child.stdin.end("q\n");
              }
            }
          } catch (error) {
            interactionError = error;
            child.kill("SIGKILL");
          }
        });
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolve(code));
        });
        assert.ifError(interactionError);
        const didSend = ["continue", "regenerate-abort", "allow"].includes(action);
        assert.equal(
          code,
          action === "continue" || action === "allow" ? 0 : 1,
          output + errorOutput,
        );
        assert.equal(secretPrompts, action === "allow" ? 0 : action === "regenerate-abort" ? 2 : 1);
        assert.equal(reviewPrompts, didSend ? 1 : 0);
        assert.equal(requests().length, didSend ? 1 : 0);
        if (didSend) {
          const body = requests()[0]!.body;
          const input = (body.input ?? body.messages)![0]!.content;
          assert.ok(JSON.parse(input).diff.includes(token));
          assert.doesNotMatch(input, /later working-tree content/);
        }
        assert.equal((output + errorOutput).includes(token), false);
        assert.doesNotMatch(output + errorOutput, /Commit created/);
        assert.equal(repo.git(["ls-files", "--stage", "-z"]), expectedIndex);
        repo.git(["rev-parse", "--verify", "--quiet", "HEAD"], { status: 1 });
      },
    );
  }
}
