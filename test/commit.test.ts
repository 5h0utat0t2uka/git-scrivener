import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
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
  await commitCandidate(message, snapshot, {
    ...repo,
    temporaryDirectory: repo.cwd,
    onOutputLine: (line) => output.push(line),
  });
  assert.ok(output[0]?.includes(message.split("\n")[0]!));
  assert.ok(output.at(-1)?.endsWith("file.txt"), "finish reading Git output before returning");
  assert.ok(output.every((line) => !line.includes("\n")));
  assert.equal(repo.git(["show", "HEAD:file.txt"]), "staged\n");
  assert.equal(repo.git(["log", "-1", "--format=%B"]).trim(), message);
  assert.equal(readFileSync(join(repo.cwd, "file.txt"), "utf8"), "unstaged after generation\n");
  assert.equal(existsSync(join(repo.cwd, "unexpected")), false);
  assert.ok(!readdirSync(repo.cwd).some((name) => name.startsWith("git-scrivener-commit-")));
});

test("runs the configured pre-commit and commit-msg hooks", async (t) => {
  const repo = fixture(t);
  const shell = repo.git(["var", "GIT_SHELL_PATH"]).trim();
  for (const name of ["pre-commit", "commit-msg"]) {
    repo.write(
      `empty-hooks/${name}`,
      `#!${shell}\nprintf 'ran' > '${name}-ran'\nprintf 'hook diagnostic: ${name}\\n'\n`,
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
    onOutputLine: (line) => output.push(line),
  });
  assert.ok(output.length > 0);
  assert.ok(output.every((line) => !line.includes("hook diagnostic:")));
  assert.equal(readFileSync(join(repo.cwd, "pre-commit-ran"), "utf8"), "ran");
  assert.equal(readFileSync(join(repo.cwd, "commit-msg-ran"), "utf8"), "ran");
});

test("does not bypass a failing hook or reset the index", async (t) => {
  const repo = fixture(t);
  const shell = repo.git(["var", "GIT_SHELL_PATH"]).trim();
  repo.write("empty-hooks/commit-msg", `#!${shell}\nexit 1\n`);
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
      onOutputLine: (line) => output.push(line),
    }),
    CommitError,
  );
  assert.deepEqual(output, []);
  repo.git(["rev-parse", "--verify", "--quiet", "HEAD"], { status: 1 });
  assert.equal(repo.git(["ls-files", "--stage", "-z"]), index);
});

test("respects SSH signing and stops on signer failure without an unsigned retry", async (t) => {
  const repo = fixture(t);
  const shell = repo.git(["var", "GIT_SHELL_PATH"]).trim();
  repo.write("signer", `#!${shell}\nprintf 'attempt\\n' >> signer-attempts\nexit 1\n`);
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
      onOutputLine: (line) => output.push(line),
    }),
    CommitError,
  );
  assert.deepEqual(output, []);
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
