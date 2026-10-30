import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { commitCandidate, CommitError } from "../src/commit.ts";
import { readStagedSnapshot, RepositoryError } from "../src/git.ts";
import { fixture } from "./fixture.ts";

test("commits the initial index and leaves later unstaged edits untouched", async (t) => {
  const repo = fixture(t);
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  repo.write("file.txt", "unstaged after generation\n");
  const message = "feat: keep $(touch unexpected) and quotes 'literal'\n\nRefs: #123";
  const output: string[] = [];
  const temporaryDirectory = join(repo.cwd, "temporary 'quoted' $(touch injected)");
  mkdirSync(temporaryDirectory);
  await commitCandidate(message, snapshot, {
    ...repo,
    temporaryDirectory,
    onOutput: (chunk) => output.push(chunk),
  });
  assert.ok(output.join("").split("\n")[0]?.includes(message.split("\n")[0]!));
  assert.ok(output.join("").endsWith("file.txt\n"), "finish reading Git output before returning");
  assert.equal(repo.git(["show", "HEAD:file.txt"]), "staged\n");
  assert.equal(repo.git(["log", "-1", "--format=%B"]).trim(), message);
  assert.equal(readFileSync(join(repo.cwd, "file.txt"), "utf8"), "unstaged after generation\n");
  assert.equal(existsSync(join(repo.cwd, "unexpected")), false);
  assert.equal(existsSync(join(repo.cwd, "injected")), false);
  assert.deepEqual(readdirSync(temporaryDirectory), []);
});

test("runs the configured pre-commit and commit-msg hooks", async (t) => {
  const repo = fixture(t);
  const shell = repo.git(["var", "GIT_SHELL_PATH"]).trim();
  for (const name of ["pre-commit", "commit-msg"]) {
    repo.write(
      `empty-hooks/${name}`,
      `#!${shell}\nprintf 'ran' > '${name}-ran'\nprintf 'hook stdout: ${name}\\n'\nprintf 'hook stderr: ${name}\\n' >&2\n`,
    );
    chmodSync(join(repo.cwd, "empty-hooks", name), 0o700);
  }
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  const output: string[] = [];
  await commitCandidate("feat: run hooks", snapshot, {
    ...repo,
    temporaryDirectory: repo.cwd,
    onOutput: (chunk) => output.push(chunk),
  });
  const text = output.join("");
  assert.match(text, /hook stdout: pre-commit\nhook stderr: pre-commit\n/);
  assert.match(text, /hook stdout: commit-msg\nhook stderr: commit-msg\n/);
  assert.ok(text.indexOf("hook stderr: commit-msg") < text.indexOf("feat: run hooks"));
  assert.equal(readFileSync(join(repo.cwd, "pre-commit-ran"), "utf8"), "ran");
  assert.equal(readFileSync(join(repo.cwd, "commit-msg-ran"), "utf8"), "ran");
});

test("does not bypass a failing hook or reset the index", async (t) => {
  const repo = fixture(t);
  const shell = repo.git(["var", "GIT_SHELL_PATH"]).trim();
  repo.write(
    "empty-hooks/commit-msg",
    `#!${shell}\nprintf 'hook rejected the commit\\n' >&2\nexit 1\n`,
  );
  chmodSync(join(repo.cwd, "empty-hooks/commit-msg"), 0o700);
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  const index = repo.git(["ls-files", "--stage", "-z"]);
  const output: string[] = [];
  await assert.rejects(
    commitCandidate("feat: invoke hooks", snapshot, {
      ...repo,
      temporaryDirectory: repo.cwd,
      onOutput: (chunk) => output.push(chunk),
    }),
    CommitError,
  );
  assert.match(output.join(""), /hook rejected the commit/);
  assert.doesNotMatch(output.join(""), /\[main/);
  repo.git(["rev-parse", "--verify", "--quiet", "HEAD"], { status: 1 });
  assert.equal(repo.git(["ls-files", "--stage", "-z"]), index);
});

test("hook color preferences are scoped to the commit process and terminal output", async (t) => {
  const cases: {
    name: string;
    env: NodeJS.ProcessEnv;
    outputIsTTY: boolean;
    capture: boolean;
    expected: string;
  }[] = [
    {
      name: "terminal defaults",
      env: {},
      outputIsTTY: true,
      capture: true,
      expected: "always/always",
    },
    {
      name: "explicit auto",
      env: { PRE_COMMIT_COLOR: "auto", PREK_COLOR: "auto" },
      outputIsTTY: true,
      capture: true,
      expected: "always/always",
    },
    {
      name: "explicit preferences",
      env: { PRE_COMMIT_COLOR: "never", PREK_COLOR: "always" },
      outputIsTTY: true,
      capture: true,
      expected: "never/always",
    },
    {
      name: "independent preferences",
      env: { PRE_COMMIT_COLOR: "always", PREK_COLOR: "never" },
      outputIsTTY: true,
      capture: true,
      expected: "always/never",
    },
    {
      name: "NO_COLOR",
      env: { NO_COLOR: "1" },
      outputIsTTY: true,
      capture: true,
      expected: "unset/unset",
    },
    {
      name: "empty NO_COLOR",
      env: { NO_COLOR: "" },
      outputIsTTY: true,
      capture: true,
      expected: "always/always",
    },
    {
      name: "FORCE_COLOR=0",
      env: { FORCE_COLOR: "0" },
      outputIsTTY: true,
      capture: true,
      expected: "unset/unset",
    },
    {
      name: "dumb terminal",
      env: { TERM: "dumb" },
      outputIsTTY: true,
      capture: true,
      expected: "unset/unset",
    },
    {
      name: "redirected output",
      env: {},
      outputIsTTY: false,
      capture: true,
      expected: "unset/unset",
    },
    {
      name: "plain output",
      env: {},
      outputIsTTY: true,
      capture: false,
      expected: "unset/unset",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const repo = fixture(t);
      for (const variable of ["PRE_COMMIT_COLOR", "PREK_COLOR", "NO_COLOR", "FORCE_COLOR"]) {
        delete repo.env[variable];
      }
      repo.env.TERM = "xterm-256color";
      Object.assign(repo.env, scenario.env);
      const originalEnv = { ...repo.env };
      const shell = repo.git(["var", "GIT_SHELL_PATH"]).trim();
      repo.write(
        "empty-hooks/pre-commit",
        `#!${shell}\nprintf '%s/%s' "\${PRE_COMMIT_COLOR-unset}" "\${PREK_COLOR-unset}" > hook-colors\n`,
      );
      chmodSync(join(repo.cwd, "empty-hooks/pre-commit"), 0o700);
      repo.write("file.txt", "staged\n");
      repo.git(["add", "file.txt"]);
      const snapshot = await readStagedSnapshot(repo);
      await commitCandidate("test: hook colors", snapshot, {
        ...repo,
        temporaryDirectory: repo.cwd,
        outputIsTTY: scenario.outputIsTTY,
        ...(scenario.capture ? { onOutput: () => {} } : {}),
      });
      assert.equal(readFileSync(join(repo.cwd, "hook-colors"), "utf8"), scenario.expected);
      assert.deepEqual(repo.env, originalEnv, "do not change the caller's environment");
    });
  }
});

test("colored hook failures still stop the commit and preserve the index", async (t) => {
  const repo = fixture(t);
  const shell = repo.git(["var", "GIT_SHELL_PATH"]).trim();
  repo.env.PRE_COMMIT_COLOR = "auto";
  repo.env.TERM = "xterm-256color";
  delete repo.env.NO_COLOR;
  delete repo.env.FORCE_COLOR;
  repo.env.OPENAI_API_KEY = "synthetic-key-not-for-hooks";
  repo.env.ANTHROPIC_API_KEY = "synthetic-anthropic-key-not-for-hooks";
  repo.write(
    "empty-hooks/pre-commit",
    `#!${shell}
[ -z "\${OPENAI_API_KEY+x}" ] || exit 2
[ -z "\${ANTHROPIC_API_KEY+x}" ] || exit 2
[ "$PRE_COMMIT_COLOR" = always ] || exit 3
printf '\\033[41mFailed\\033[m\\n' >&2
exit 1
`,
  );
  chmodSync(join(repo.cwd, "empty-hooks/pre-commit"), 0o700);
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  const index = repo.git(["ls-files", "--stage", "-z"]);
  let output = "";
  await assert.rejects(
    commitCandidate("test: colored failure", snapshot, {
      ...repo,
      temporaryDirectory: repo.cwd,
      outputIsTTY: true,
      onOutput: (chunk) => {
        output += chunk;
      },
    }),
    CommitError,
  );
  assert.ok(output.includes("\x1b[41mFailed\x1b[m\n"));
  repo.git(["rev-parse", "--verify", "--quiet", "HEAD"], { status: 1 });
  assert.equal(repo.git(["ls-files", "--stage", "-z"]), index);
});

test("shows a hook's partial stderr before it continues, without waiting for a newline", async (t) => {
  const repo = fixture(t);
  const shell = repo.git(["var", "GIT_SHELL_PATH"]).trim();
  repo.write(
    "empty-hooks/pre-commit",
    `#!${shell}
printf 'Checking 日本語...' >&2
attempt=0
while [ ! -f output-seen ]; do
  if [ "$attempt" -ge 50 ]; then
    printf 'output was buffered\\n' >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
printf 'Passed\\n' >&2
`,
  );
  chmodSync(join(repo.cwd, "empty-hooks/pre-commit"), 0o700);
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  let output = "";
  await commitCandidate("test: stream hook output", snapshot, {
    ...repo,
    temporaryDirectory: repo.cwd,
    onOutput: (chunk) => {
      output += chunk;
      if (output.includes("Checking 日本語...")) repo.write("output-seen", "yes");
    },
  });
  assert.match(output, /Checking 日本語\.\.\.Passed\n/);
  assert.ok(output.indexOf("Passed") < output.indexOf("test: stream hook output"));
  assert.equal(repo.git(["log", "-1", "--format=%s"]).trim(), "test: stream hook output");
});

test("commits with native terminal output when no output renderer is supplied", async (t) => {
  const repo = fixture(t);
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  await commitCandidate("test: native output", snapshot, { ...repo, temporaryDirectory: repo.cwd });
  assert.equal(repo.git(["log", "-1", "--format=%s"]).trim(), "test: native output");
});

test("respects SSH signing and stops on signer failure without an unsigned retry", async (t) => {
  const repo = fixture(t);
  const shell = repo.git(["var", "GIT_SHELL_PATH"]).trim();
  repo.write(
    "signer",
    `#!${shell}\nprintf 'attempt\\n' >> signer-attempts\nprintf 'synthetic signer failed\\n' >&2\nexit 1\n`,
  );
  chmodSync(join(repo.cwd, "signer"), 0o700);
  repo.write("signing.pub", "synthetic public key fixture\n");
  repo.git(["config", "commit.gpgsign", "true"]);
  repo.git(["config", "gpg.format", "ssh"]);
  repo.git(["config", "gpg.ssh.program", join(repo.cwd, "signer")]);
  repo.git(["config", "user.signingkey", join(repo.cwd, "signing.pub")]);
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  const index = repo.git(["ls-files", "--stage", "-z"]);
  const output: string[] = [];
  await assert.rejects(
    commitCandidate("feat: require signing", snapshot, {
      ...repo,
      temporaryDirectory: repo.cwd,
      onOutput: (chunk) => output.push(chunk),
    }),
    CommitError,
  );
  assert.match(output.join(""), /synthetic signer failed/);
  assert.doesNotMatch(output.join(""), /\[main/);
  assert.equal(readFileSync(join(repo.cwd, "signer-attempts"), "utf8"), "attempt\n");
  repo.git(["rev-parse", "--verify", "--quiet", "HEAD"], { status: 1 });
  assert.equal(repo.git(["ls-files", "--stage", "-z"]), index);
});

test("refuses to commit when staged contents changed after generation", async (t) => {
  const repo = fixture(t);
  repo.write("file.txt", "original staged\n");
  repo.git(["add", "file.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  repo.write("file.txt", "new staged\n");
  repo.git(["add", "file.txt"]);
  const index = repo.git(["ls-files", "--stage", "-z"]);
  await assert.rejects(
    commitCandidate("feat: old candidate", snapshot, {
      ...repo,
      temporaryDirectory: repo.cwd,
    }),
    RepositoryError,
  );
  repo.git(["rev-parse", "--verify", "--quiet", "HEAD"], { status: 1 });
  assert.equal(repo.git(["ls-files", "--stage", "-z"]), index);
});

test("refuses to commit after HEAD changes even when the index is unchanged", async (t) => {
  const repo = fixture(t);
  repo.git(["commit", "--allow-empty", "-m", "test: initial"]);
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  const tree = repo.git(["rev-parse", "HEAD^{tree}"]).trim();
  const other = repo.git(["commit-tree", tree, "-p", "HEAD", "-m", "test: another commit"]).trim();
  repo.git(["update-ref", "HEAD", other]);
  await assert.rejects(
    commitCandidate("feat: old candidate", snapshot, {
      ...repo,
      temporaryDirectory: repo.cwd,
    }),
    RepositoryError,
  );
  assert.equal(repo.git(["rev-parse", "HEAD"]).trim(), other);
});

test("refuses to commit on a different branch pointing at the same commit", async (t) => {
  const repo = fixture(t);
  repo.git(["commit", "--allow-empty", "-m", "test: initial"]);
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  repo.git(["switch", "-c", "other"]);
  await assert.rejects(
    commitCandidate("feat: old candidate", snapshot, {
      ...repo,
      temporaryDirectory: repo.cwd,
    }),
    RepositoryError,
  );
  assert.equal(repo.git(["rev-parse", "HEAD"]).trim(), snapshot.head);
});

test("rejects an invalid confirmed message before starting git commit", async (t) => {
  const repo = fixture(t);
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  await assert.rejects(
    commitCandidate("", snapshot, { ...repo, temporaryDirectory: repo.cwd }),
    /empty/,
  );
  repo.git(["rev-parse", "--verify", "--quiet", "HEAD"], { status: 1 });
});
