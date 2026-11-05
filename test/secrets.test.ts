import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { assertNoSecrets, SecretScanError } from "../src/secrets.ts";
import { readStagedSnapshot } from "../src/git.ts";
import { fixture } from "./fixture.ts";

function reportingScanner(t: TestContext, report: string, exitCode = 42) {
  const repo = fixture(t, false);
  repo.write(
    "betterleaks",
    `#!${process.execPath}
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
const args = process.argv.slice(2);
assert.ok(args.includes("--report-format=template"));
assert.ok(args.includes("--report-path=-"));
assert.ok(args.includes("--redact=100"));
assert.ok(args.includes("--validation=false"));
const template = args.find((arg) => arg.startsWith("--report-template=")).split("=")[1];
assert.equal(statSync(template).mode & 0o777, 0o600);
assert.equal(statSync(process.cwd()).mode & 0o777, 0o700);
assert.equal(readFileSync(template, "utf8"), '{{range .}}{{printf "%s\\\\t%d\\\\t%d\\\\n" .RuleID .StartLine .EndLine}}{{end}}');
for await (const chunk of process.stdin) {}
process.stderr.write("PRIVATE_SCANNER_LOG");
process.stdout.write(${JSON.stringify(report)});
process.exitCode = ${exitCode};
`,
  );
  chmodSync(join(repo.cwd, "betterleaks"), 0o700);
  repo.env.PATH = `${repo.cwd}${delimiter}${repo.env.PATH ?? ""}`;
  return repo;
}

test("scanner startup failure does not leave a timer keeping the process alive", (t) => {
  const repo = fixture(t, false);
  const source = new URL("../src/secrets.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from 'node:assert/strict';
    import { assertNoSecrets } from ${JSON.stringify(source)};
    await assert.rejects(
      assertNoSecrets('ordinary text', { temporaryDirectory: process.cwd() }),
      /Could not run Betterleaks/
    );
  `,
    ],
    {
      cwd: repo.cwd,
      env: { ...repo.env, PATH: repo.cwd },
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(repo.cwd), []);
});

test("accepts ordinary text and removes its temporary directory", async (t) => {
  const repo = fixture(t, false);
  await assertNoSecrets("+add a staged-diff reader\n", {
    env: repo.env,
    temporaryDirectory: repo.cwd,
  });
  assert.deepEqual(readdirSync(repo.cwd), []);
});

test("does not pass either provider's API key to the scanner", async (t) => {
  const repo = fixture(t);
  const shell = repo.git(["var", "GIT_SHELL_PATH"]).trim();
  repo.write(
    "betterleaks",
    `#!${shell}
[ -z "\${OPENAI_API_KEY+x}" ] || exit 2
[ -z "\${ANTHROPIC_API_KEY+x}" ] || exit 2
cat > /dev/null
`,
  );
  chmodSync(join(repo.cwd, "betterleaks"), 0o700);
  const env = {
    ...repo.env,
    OPENAI_API_KEY: "test-openai-key",
    ANTHROPIC_API_KEY: "test-anthropic-key",
    PATH: `${repo.cwd}${delimiter}${repo.env.PATH ?? ""}`,
  };
  await assertNoSecrets("ordinary text\n", { env, temporaryDirectory: repo.cwd });
  assert.equal(env.OPENAI_API_KEY, "test-openai-key");
  assert.equal(env.ANTHROPIC_API_KEY, "test-anthropic-key");
});

test("uses embedded rules despite configuration overrides and inline allow comments", async (t) => {
  const repo = fixture(t, false);
  const bypass = "[allowlist]\nregexes = ['.*']\n";
  repo.write(".betterleaks.toml", bypass);
  repo.write(".gitleaks.toml", bypass);
  const token = "ghp_" + "aB3dE5gH7jK9mN2pQ4sT6vW8xY0zA1bC3dE5";
  await assert.rejects(
    assertNoSecrets(`token = "${token}" # betterleaks:allow\n`, {
      env: {
        ...repo.env,
        BETTERLEAKS_CONFIG: "/nonexistent-config",
        GITLEAKS_CONFIG: "/nonexistent-config",
        BETTERLEAKS_CONFIG_TOML: bypass,
        GITLEAKS_CONFIG_TOML: bypass,
      },
      temporaryDirectory: repo.cwd,
    }),
    /Potential secrets detected/,
  );
  assert.deepEqual(readdirSync(repo.cwd).sort(), [".betterleaks.toml", ".gitleaks.toml"]);
});

test("reports added, removed, context, and previous-candidate locations without source text", async (t) => {
  const diff = [
    "diff --git a/old name.env b/new name.env",
    "--- a/old name.env\t",
    "+++ b/new name.env\t",
    "@@ -10,3 +20,3 @@ PRIVATE_HUNK_CONTEXT",
    " PRIVATE_CONTEXT_VALUE",
    "-PRIVATE_REMOVED_VALUE",
    "+PRIVATE_ADDED_VALUE",
    " PRIVATE_OTHER_VALUE",
  ].join("\n");
  const previousCandidate = "feat: update\n\nPRIVATE_CANDIDATE_VALUE";
  const report =
    [
      "github-pat\t5\t7", // Context, removal, and addition.
      "github-pat\t16\t18", // The same lines in the normalized copy.
      "generic-api-key\t11\t11", // Previous candidate's third line.
    ].join("\n") + "\n";
  const repo = reportingScanner(t, report);
  await assert.rejects(
    assertNoSecrets(diff, { env: repo.env, temporaryDirectory: repo.cwd, previousCandidate }),
    (error: unknown) => {
      assert.ok(error instanceof SecretScanError);
      assert.match(error.message, /github-pat — old name\.env:11 \(removed, HEAD\)/);
      assert.match(error.message, /github-pat — new name\.env:21 \(added, staged\)/);
      assert.match(error.message, /github-pat — new name\.env:20 \(context, staged\)/);
      assert.match(error.message, /generic-api-key — previous candidate:3 \(message line\)/);
      assert.equal(
        error.message.split("github-pat —").length - 1,
        3,
        "deduplicate normalized findings",
      );
      assert.doesNotMatch(error.message, /PRIVATE_/);
      return true;
    },
  );
  assert.deepEqual(readdirSync(repo.cwd), ["betterleaks"]);
});

test("maps new and deleted files, multiple hunks, quoted paths, and multiline matches", async (t) => {
  const diff = [
    "diff --git a/added.txt b/added.txt",
    "--- /dev/null",
    "+++ b/added.txt",
    "@@ -0,0 +1,2 @@",
    "+PRIVATE_FIRST",
    "+PRIVATE_SECOND",
    'diff --git "a/deleted\\nfile.txt" "b/deleted\\nfile.txt"',
    '--- "a/deleted\\nfile.txt"',
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "--- PRIVATE_REMOVAL",
    "\\ No newline at end of file",
    "diff --git a/config.txt b/config.txt",
    "--- a/config.txt",
    "+++ b/config.txt",
    "@@ -2 +2 @@",
    "-PRIVATE_BEFORE",
    "+PRIVATE_AFTER",
    "@@ -20,0 +21 @@",
    "+PRIVATE_LATER",
    "",
  ].join("\n");
  const repo = reportingScanner(t, "private-key\t5\t6\nprivate-key\t11\t11\nprivate-key\t20\t20\n");
  await assert.rejects(
    assertNoSecrets(diff, { env: repo.env, temporaryDirectory: repo.cwd }),
    (error: unknown) => {
      assert.ok(error instanceof SecretScanError);
      assert.match(error.message, /private-key — added\.txt:1-2 \(added, staged\)/);
      assert.ok(error.message.includes('private-key — "deleted\\nfile.txt":1 (removed, HEAD)'));
      assert.match(error.message, /private-key — config\.txt:21 \(added, staged\)/);
      assert.doesNotMatch(error.message, /PRIVATE_/);
      return true;
    },
  );
});

test("escapes filename controls and identifies patch metadata without echoing it", async (t) => {
  const diff = [
    "diff --git a/file b/file",
    "--- a/file\u202e.txt",
    "+++ b/file\u202e.txt",
    "@@ -0,0 +1 @@ PRIVATE_HEADER",
    "+PRIVATE_CONTENT",
  ].join("\n");
  const repo = reportingScanner(t, "generic-api-key\t4\t5\n");
  await assert.rejects(
    assertNoSecrets(diff, { env: repo.env, temporaryDirectory: repo.cwd }),
    (error: unknown) => {
      assert.ok(error instanceof SecretScanError);
      assert.match(error.message, /staged diff:4 \(patch line\)/);
      assert.ok(error.message.includes("file\\u{202e}.txt:1 (added, staged)"));
      assert.equal(error.message.includes("\u202e"), false);
      assert.doesNotMatch(error.message, /PRIVATE_/);
      return true;
    },
  );
});

test("invalid, missing, oversized, and unsuccessful reports still block without exposing output", async (t) => {
  for (const [report, exitCode] of [
    ["", 42],
    ["PRIVATE_REPORT\n", 42],
    ["github-pat\t0\t1\n", 42],
    ["github-pat\t1\t999\n", 42],
    ["github-pat\t2\t1\n", 42],
    ["github-pat\u001b[2J\t1\t1\n", 42],
    ["PRIVATE_REPORT".repeat(30_000), 42],
    ["github-pat\t1\t1\n", 0],
    ["github-pat\t1\t1\n", 2],
  ] as const) {
    const repo = reportingScanner(t, report, exitCode);
    await assert.rejects(
      assertNoSecrets("PRIVATE_SOURCE", { env: repo.env, temporaryDirectory: repo.cwd }),
      (error: unknown) => {
        assert.ok(error instanceof SecretScanError);
        assert.match(error.message, /No request was made/);
        assert.match(
          error.message,
          exitCode === 42 ? /locations are unavailable/ : /did not complete/,
        );
        assert.doesNotMatch(error.message, /PRIVATE_/);
        assert.equal(error.message.includes("\x1b"), false);
        return true;
      },
    );
    assert.deepEqual(readdirSync(repo.cwd), ["betterleaks"]);
  }
});

test("limits displayed locations and explicitly reports omitted entries", async (t) => {
  const report = Array.from({ length: 22 }, (_value, index) => `rule-${index}\t1\t1\n`).join("");
  const repo = reportingScanner(t, report);
  await assert.rejects(
    assertNoSecrets("PRIVATE_SOURCE", { env: repo.env, temporaryDirectory: repo.cwd }),
    (error: unknown) => {
      assert.ok(error instanceof SecretScanError);
      assert.equal(error.message.split("(patch line)").length - 1, 20);
      assert.match(error.message, /2 more locations omitted/);
      return true;
    },
  );
});

test("real scanner reports staged line numbers past input chunks despite later working-tree edits", async (t) => {
  const repo = fixture(t);
  const token = "ghp_" + "aB3dE5gH7jK9mN2pQ4sT6vW8xY0zA1bC3dE5";
  repo.write("config.txt", "ordinary content\n".repeat(10_000) + `token = "${token}"\n`);
  repo.git(["add", "config.txt"]);
  const snapshot = await readStagedSnapshot({ cwd: repo.cwd, env: repo.env });
  repo.write("config.txt", "later working-tree content\n");
  const index = repo.git(["ls-files", "--stage", "-z"]);
  await assert.rejects(
    assertNoSecrets(snapshot.diff, { env: repo.env, temporaryDirectory: repo.cwd }),
    (error: unknown) => {
      assert.ok(error instanceof SecretScanError);
      assert.match(error.message, /github-pat — config\.txt:10001 \(added, staged\)/);
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes("token ="), false);
      return true;
    },
  );
  assert.equal(repo.git(["ls-files", "--stage", "-z"]), index);
});
