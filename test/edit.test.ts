import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { editMessage, EditorError } from "../src/edit.ts";
import { fixture } from "./fixture.ts";

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

test("resolves Git's editor with quoted arguments and uses private temporary files", async (t) => {
  const repo = fixture(t);
  const script = join(repo.cwd, "editor with spaces.mjs");
  repo.write(
    "editor with spaces.mjs",
    `
    import assert from 'node:assert/strict';
    import { statSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    const [flag, label, file] = process.argv.slice(2);
    assert.equal(flag, '--label');
    assert.equal(label, 'two words');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    writeFileSync(file, 'fix(cli): accept edited text\\n');
  `,
  );
  repo.git([
    "config",
    "core.editor",
    `${quote(process.execPath)} ${quote(script)} --label 'two words'`,
  ]);
  const temporaryDirectory = join(repo.cwd, "temp with ' quotes $(nope)");
  mkdirSync(temporaryDirectory);
  const edited = await editMessage("feat: original candidate", {
    cwd: repo.cwd,
    env: { ...repo.env, OPENAI_API_KEY: "test-api-key", ANTHROPIC_API_KEY: "test-anthropic-key" },
    temporaryDirectory,
  });
  assert.equal(edited, "fix(cli): accept edited text");
  assert.deepEqual(readdirSync(temporaryDirectory), []);
  repo.git(["rev-parse", "--verify", "--quiet", "HEAD"], { status: 1 });
});

test("rejects editor failure and leaves staged contents intact", async (t) => {
  const repo = fixture(t);
  repo.write("file.txt", "staged\n");
  repo.git(["add", "file.txt"]);
  const index = repo.git(["ls-files", "--stage", "-z"]);
  await assert.rejects(
    editMessage("feat: original", {
      cwd: repo.cwd,
      env: { ...repo.env, GIT_EDITOR: "false" },
      temporaryDirectory: repo.cwd,
    }),
    EditorError,
  );
  assert.equal(repo.git(["ls-files", "--stage", "-z"]), index);
  assert.ok(!readdirSync(repo.cwd).some((name) => name.startsWith("git-scrivener-edit-")));
});

test("an editor exit without saving returns the original candidate without committing", async (t) => {
  const repo = fixture(t);
  repo.git(["config", "core.editor", "false"]);
  const result = await editMessage("feat: original", {
    cwd: repo.cwd,
    env: { ...repo.env, GIT_EDITOR: ":" },
    temporaryDirectory: repo.cwd,
  });
  assert.equal(result, "feat: original");
  repo.git(["rev-parse", "--verify", "--quiet", "HEAD"], { status: 1 });
});

test("rejects empty, malformed, oversized, and non-UTF-8 edited messages", async (t) => {
  const repo = fixture(t);
  for (const expression of [
    "''",
    "'not conventional'",
    "'fix: ' + 'a'.repeat(65536)",
    "Buffer.from([0x80])",
  ]) {
    repo.write(
      "editor.mjs",
      `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], ${expression});`,
    );
    await assert.rejects(
      editMessage("feat: original", {
        cwd: repo.cwd,
        env: {
          ...repo.env,
          GIT_EDITOR: `${quote(process.execPath)} ${quote(join(repo.cwd, "editor.mjs"))}`,
        },
        temporaryDirectory: repo.cwd,
      }),
    );
    assert.ok(!readdirSync(repo.cwd).some((name) => name.startsWith("git-scrivener-edit-")));
  }
});

test("does not follow an editor-created symlink", async (t) => {
  const repo = fixture(t);
  repo.write("other.txt", "unrelated content\n");
  repo.write(
    "editor.mjs",
    `
    import { unlinkSync, symlinkSync } from 'node:fs';
    import { resolve } from 'node:path';
    unlinkSync(process.argv[2]);
    symlinkSync(resolve('other.txt'), process.argv[2]);
  `,
  );
  await assert.rejects(
    editMessage("feat: original", {
      cwd: repo.cwd,
      env: {
        ...repo.env,
        GIT_EDITOR: `${quote(process.execPath)} ${quote(join(repo.cwd, "editor.mjs"))}`,
      },
      temporaryDirectory: repo.cwd,
    }),
    EditorError,
  );
  assert.equal(readFileSync(join(repo.cwd, "other.txt"), "utf8"), "unrelated content\n");
});
