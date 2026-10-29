import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readStagedSnapshot, RepositoryError } from "../src/git.ts";
import { fixture } from "./fixture.ts";

test("rejects a directory outside a Git working tree", async (t) => {
  const repo = fixture(t, false);
  await assert.rejects(readStagedSnapshot(repo), RepositoryError);
});

test("rejects an empty initial index and untracked files", async (t) => {
  const repo = fixture(t);
  await assert.rejects(readStagedSnapshot(repo), /No staged changes/);
  repo.write("untracked.txt", "untracked content\n");
  await assert.rejects(readStagedSnapshot(repo), /No staged changes/);
});

test("reads an initial commit without staging later working-tree edits", async (t) => {
  const repo = fixture(t);
  const name = "file with spaces;$(echo nope).txt";
  repo.write(name, "staged content\n");
  repo.git(["add", "--", name]);
  repo.write(name, "staged content\nunstaged content\n");
  const indexBefore = repo.git(["ls-files", "--stage", "-z"]);

  const snapshot = await readStagedSnapshot(repo);
  assert.equal(snapshot.head, null);
  assert.equal(snapshot.headRef, "refs/heads/main");
  assert.deepEqual(
    snapshot.files.map((file) => file.toString("utf8")),
    [name],
  );
  assert.match(snapshot.diff, /\+staged content/);
  assert.doesNotMatch(snapshot.diff, /unstaged content/);
  assert.equal(repo.git(["ls-files", "--stage", "-z"]), indexBefore);
  assert.equal(readFileSync(join(repo.cwd, name), "utf8"), "staged content\nunstaged content\n");
});

test("reads only staged changes relative to HEAD in an existing repository", async (t) => {
  const repo = fixture(t);
  repo.write("file.txt", "original\n");
  repo.git(["add", "file.txt"]);
  repo.git(["commit", "-m", "test: initial"]);
  const head = repo.git(["rev-parse", "HEAD"]).trim();
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  repo.write("file.txt", "unstaged\n");

  const snapshot = await readStagedSnapshot(repo);
  assert.equal(snapshot.head, head);
  assert.match(snapshot.diff, /-original/);
  assert.match(snapshot.diff, /\+staged/);
  assert.doesNotMatch(snapshot.diff, /unstaged/);
  assert.equal(repo.git(["rev-parse", "HEAD"]).trim(), head);
});

test("ignores unstaged-only changes in an existing repository", async (t) => {
  const repo = fixture(t);
  repo.write("file.txt", "original\n");
  repo.git(["add", "file.txt"]);
  repo.git(["commit", "-m", "test: initial"]);
  repo.write("file.txt", "unstaged\n");
  await assert.rejects(readStagedSnapshot(repo), /No staged changes/);
});

test("includes staged files outside the current subdirectory", async (t) => {
  const repo = fixture(t);
  repo.write("outside.txt", "staged outside\n");
  repo.git(["add", "outside.txt"]);
  repo.git(["config", "diff.relative", "true"]);
  const cwd = join(repo.cwd, "subdirectory");
  mkdirSync(cwd);
  const snapshot = await readStagedSnapshot({ cwd, env: repo.env });
  assert.match(snapshot.diff, /\+staged outside/);
  assert.deepEqual(
    snapshot.files.map((file) => file.toString("utf8")),
    ["outside.txt"],
  );
});

test("collects staged paths without splitting newlines or interpreting terminal controls", async (t) => {
  const repo = fixture(t);
  const names = ["line\nbreak.txt", "tab\tname.txt", "escape\x1b[2J.txt", "日本語.txt"];
  for (const name of names) {
    repo.write(name, "staged\n");
    repo.git(["add", "--", name]);
  }
  const snapshot = await readStagedSnapshot(repo);
  assert.deepEqual(snapshot.files.map((file) => file.toString("utf8")).sort(), names.sort());
});

test("lists a rename destination once and includes staged deletions", async (t) => {
  const repo = fixture(t);
  repo.write("original.txt", "keep this content\n");
  repo.write("deleted.txt", "remove this content\n");
  repo.git(["add", "original.txt", "deleted.txt"]);
  repo.git(["commit", "-m", "test: initial"]);
  repo.git(["config", "diff.renames", "true"]);
  repo.git(["mv", "original.txt", "renamed.txt"]);
  repo.git(["rm", "deleted.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  assert.deepEqual(
    snapshot.files.map((file) => file.toString("utf8")),
    ["deleted.txt", "renamed.txt"],
  );
});

test("rejects unmerged paths even when they are outside the current subdirectory", async (t) => {
  const repo = fixture(t);
  repo.write("conflict.txt", "base\n");
  repo.git(["add", "conflict.txt"]);
  repo.git(["commit", "-m", "test: base"]);
  repo.git(["switch", "-c", "topic"]);
  repo.write("conflict.txt", "topic\n");
  repo.git(["commit", "-am", "test: topic"]);
  repo.git(["switch", "main"]);
  repo.write("conflict.txt", "main\n");
  repo.git(["commit", "-am", "test: main"]);
  repo.git(["merge", "topic"], { status: 1 });
  const cwd = join(repo.cwd, "subdirectory");
  mkdirSync(cwd);
  await assert.rejects(readStagedSnapshot({ cwd, env: repo.env }), /Resolve all unmerged paths/);
});

test("rejects an oversized diff instead of returning a truncated patch", async (t) => {
  const repo = fixture(t);
  repo.write("large.txt", "large change\n".repeat(1_000));
  repo.git(["add", "large.txt"]);
  await assert.rejects(
    readStagedSnapshot({ ...repo, maxDiffBytes: 512 }),
    /exceeds the 512-byte limit/,
  );
});

test("measures the complete diff in UTF-8 bytes, including its patch headers", async (t) => {
  const repo = fixture(t);
  repo.write("unicode.txt", "日本語\n");
  repo.git(["add", "unicode.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  assert.equal(snapshot.diffBytes, Buffer.byteLength(snapshot.diff, "utf8"));
  assert.ok(snapshot.diffBytes > snapshot.diff.length);
  await assert.doesNotReject(readStagedSnapshot({ ...repo, maxDiffBytes: snapshot.diffBytes }));
  await assert.rejects(
    readStagedSnapshot({ ...repo, maxDiffBytes: snapshot.diffBytes - 1 }),
    /exceeds/,
  );
});

test("rejects non-UTF-8 text instead of silently replacing bytes", async (t) => {
  const repo = fixture(t);
  repo.write("invalid.txt", Buffer.from([0x61, 0x80, 0x0a]));
  repo.git(["add", "invalid.txt"]);
  await assert.rejects(readStagedSnapshot(repo), /non-UTF-8/);
});

test("disables configured external diff and textconv commands", async (t) => {
  const repo = fixture(t);
  repo.write(".gitattributes", "*.txt diff=custom\n");
  repo.write("file.txt", "staged content\n");
  repo.git(["add", "file.txt"]);
  repo.git(["config", "diff.external", "false"]);
  repo.git(["config", "diff.custom.textconv", "false"]);
  const snapshot = await readStagedSnapshot(repo);
  assert.match(snapshot.diff, /\+staged content/);
});

test("handles a detached HEAD", async (t) => {
  const repo = fixture(t);
  repo.git(["commit", "--allow-empty", "-m", "test: initial"]);
  repo.git(["switch", "--detach"]);
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  const snapshot = await readStagedSnapshot(repo);
  assert.equal(snapshot.headRef, null);
  assert.equal(snapshot.head, repo.git(["rev-parse", "HEAD"]).trim());
});

test("retains staged submodule changes despite diff.ignoreSubmodules", async (t) => {
  const repo = fixture(t);
  repo.git(["commit", "--allow-empty", "-m", "test: initial"]);
  const head = repo.git(["rev-parse", "HEAD"]).trim();
  repo.git(["update-index", "--add", "--cacheinfo", `160000,${head},submodule`]);
  repo.git(["config", "diff.ignoreSubmodules", "all"]);
  const snapshot = await readStagedSnapshot(repo);
  assert.match(snapshot.diff, /new file mode 160000/);
  assert.match(snapshot.diff, /Subproject commit/);
});

test("returns Git's summary for a staged binary file", async (t) => {
  const repo = fixture(t);
  repo.write("binary.dat", Buffer.from([0, 1, 2, 3]));
  repo.git(["add", "binary.dat"]);
  const snapshot = await readStagedSnapshot(repo);
  assert.match(snapshot.diff, /Binary files/);
});
