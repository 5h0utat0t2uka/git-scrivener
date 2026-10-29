import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import type { TestContext } from "node:test";
import { createUi } from "../src/ui.ts";

function terminal(t: TestContext, plain = false) {
  let text = "";
  const modes: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(enabled: boolean) {
      modes.push(enabled);
    },
  });
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  t.after(() => {
    input.destroy();
    output.destroy();
  });
  return {
    input,
    modes,
    text: () => text,
    ui: createUi({ plain, input, output, errorOutput: output }),
  };
}

test(
  "Confirm is initially selected; Enter accepts it and arrow keys select the other actions",
  { timeout: 5_000 },
  async (t) => {
    for (const [keys, expected] of [
      ["\r", "confirm"],
      ["\x1b[B\r", "edit"],
      ["\x1b[B\x1b[B\r", "regenerate"],
      ["\x1b[B\x1b[B\x1b[B\r", "cancel"],
    ]) {
      const view = terminal(t);
      const result = view.ui.prompt();
      const initial = stripVTControlCharacters(view.text());
      assert.match(initial, /○  Use this commit message\?/);
      assert.match(initial, /● Confirm \(Create the commit\)/);
      view.input.write(keys);
      assert.equal(await result, expected);
      const text = stripVTControlCharacters(view.text());
      const label = expected!.charAt(0).toUpperCase() + expected!.slice(1);
      assert.ok(text.endsWith(`│  ${label}\n`));
      assert.doesNotMatch(text, /[◇◆❯]/);
      assert.equal(
        view.modes.at(-1),
        false,
        "restore terminal mode before starting an editor or Git",
      );
      assert.equal(view.input.listenerCount("keypress"), 0);
    }
  },
);

test(
  "Ctrl-C, Ctrl-D, Escape, and EOF cancel and restore terminal mode",
  { timeout: 5_000 },
  async (t) => {
    for (const key of ["\x03", "\x04", "\x1b", null]) {
      const view = terminal(t);
      const result = view.ui.prompt();
      if (key === null) view.input.end();
      else view.input.write(key);
      assert.equal(await result, null);
      assert.equal(view.modes.at(-1), false);
      assert.equal(view.input.listenerCount("keypress"), 0);
    }
  },
);

test(
  "plain prompts keep typed shortcuts, empty cancellation, and EOF",
  { timeout: 5_000 },
  async (t) => {
    for (const answer of ["c", "e", "r", "q", "", null]) {
      const view = terminal(t, true);
      const result = view.ui.prompt();
      if (answer === null) view.input.end();
      else view.input.write(`${answer}\n`);
      assert.equal(await result, answer);
      assert.equal(view.modes.length, 0);
      assert.equal(view.text().includes("\x1b"), false);
    }
  },
);

test("file listings preserve Unicode and escape unsafe filename bytes", (t) => {
  const view = terminal(t, true);
  view.ui.files([
    Buffer.from("src/日本語.ts"),
    Buffer.from("newline\n\x1b[2J\u202efile.txt"),
    Buffer.from([0xff, 0x1b]),
  ]);
  assert.match(view.text(), /Detected 3 staged files:/);
  assert.match(view.text(), /src\/日本語\.ts/);
  assert.ok(view.text().includes('"newline\\n\\u001b[2J\\u{202e}file.txt"'));
  assert.ok(view.text().includes('"\\xff\\x1b"'));
  assert.equal(view.text().includes("\x1b"), false);
  assert.equal(view.text().includes("\u202e"), false);
});

test("timeline markers decorate steps without changing file names or candidate text", async (t) => {
  const view = terminal(t);
  view.ui.start();
  view.ui.files([
    Buffer.from("README◇.md"),
    Buffer.from("src/ui.ts"),
    Buffer.from("test/ui.test.ts"),
  ]);
  await view.ui.progress(
    "Generating another candidate",
    "Candidate regenerated",
    async () => undefined,
  );
  view.ui.display("docs: describe ◇ and ❯ symbols\n\nKeep their literal contents.");
  view.ui.step("Committing with Git");
  view.ui.cancel();
  const text = stripVTControlCharacters(view.text());
  assert.match(
    text,
    /│\n○  👀 Detected 3 staged files:\n│     README◇\.md\n│     src\/ui\.ts\n│     test\/ui\.test\.ts\n/,
  );
  assert.match(text, /│\n○  Candidate regenerated in \d+\.\ds\n/);
  assert.match(text, /│\n│  docs: describe ◇ and ❯ symbols\n│\n│  Keep their literal contents\.\n/);
  assert.match(text, /│\n○  Committing with Git\n└  Cancelled\. No commit was created\.\n/);
});

test("progress shows elapsed time and releases its signal handlers on success and failure", async (t) => {
  for (const fails of [false, true]) {
    const view = terminal(t);
    const signals = ["SIGINT", "SIGTERM", "exit", "uncaughtExceptionMonitor", "unhandledRejection"];
    const listeners = signals.map((signal) => process.listenerCount(signal));
    const result = view.ui.progress("Analyzing staged changes", "Changes analyzed", async () => {
      await setTimeout(100);
      if (fails) throw new Error("PRIVATE_ERROR_BODY");
      return "candidate";
    });
    if (fails) await assert.rejects(result, /PRIVATE_ERROR_BODY/);
    else assert.equal(await result, "candidate");
    assert.ok(view.text().includes("⠋"));
    const text = stripVTControlCharacters(view.text());
    assert.match(text, fails ? /Generation failed after \d+\.\ds/ : /Changes analyzed in \d+\.\ds/);
    if (!fails) assert.match(text, /○  Changes analyzed in \d+\.\ds/);
    assert.doesNotMatch(text, /[◇❯]/);
    assert.doesNotMatch(text, /PRIVATE_ERROR_BODY/);
    assert.deepEqual(
      signals.map((signal) => process.listenerCount(signal)),
      listeners,
    );
  }
});

test("Git output continues the timeline without extra gaps and preserves indentation", (t) => {
  const view = terminal(t);
  view.ui.step("Committing with Git");
  const output = view.ui.commitOutput()!;
  output.write("Detect hardcoded secrets...");
  assert.ok(stripVTControlCharacters(view.text()).endsWith("│  Detect hardcoded secrets..."));
  output.write("Passed\nzizmor...(no files to check)Skipped\n");
  output.write("[main (root-commit) 625f1fe] docs: add README\n");
  output.write(" 1 file changed, 1 insertion(+)\n\n");
  output.write(" create mode 100644 日本語.md");
  output.finish();
  view.ui.finish("Commit created.");
  assert.equal(
    stripVTControlCharacters(view.text()),
    "│\n○  Committing with Git\n" +
      "│  Detect hardcoded secrets...Passed\n│  zizmor...(no files to check)Skipped\n" +
      "│  [main (root-commit) 625f1fe] docs: add README\n" +
      "│   1 file changed, 1 insertion(+)\n│\n" +
      "│   create mode 100644 日本語.md\n│\n└  Commit created.\n\n",
  );

  const plain = terminal(t, true);
  assert.equal(
    plain.ui.commitOutput(),
    undefined,
    "plain mode must inherit Git's terminal descriptors",
  );
  assert.equal(plain.text(), "");
});

test("commit output preserves hook colors and split escape sequences alongside the guide", (t) => {
  const view = terminal(t);
  const output = view.ui.commitOutput()!;
  output.write("Checks...");
  output.write("\x1b[");
  output.write("42mPassed\x1b[m\n");
  output.write("zizmor...\x1b[46mSkipped\x1b[m\n");
  output.finish();
  assert.ok(view.text().includes("Checks...\x1b[42mPassed\x1b[m\n"));
  assert.ok(view.text().includes("zizmor...\x1b[46mSkipped\x1b[m\n"));
  assert.equal(stripVTControlCharacters(view.text()), "│  Checks...Passed\n│  zizmor...Skipped\n");
});

test("commit output handles split CRLF, carriage returns, and partial final lines", (t) => {
  const view = terminal(t);
  const output = view.ui.commitOutput()!;
  output.write("Checking...");
  output.write("\r");
  output.write("Passed     \r");
  output.write("\n\n日本");
  output.write("語");
  output.finish();
  output.finish();
  assert.equal(
    stripVTControlCharacters(view.text()),
    "│  Checking...\r│  Passed     \r\n│\n│  日本語\n",
  );
});

test("plain progress and output contain no cursor commands or ANSI styling", async (t) => {
  const view = terminal(t, true);
  view.ui.start();
  view.ui.files([Buffer.from("README.md")]);
  view.ui.display("feat: add documentation");
  await view.ui.progress("Analyzing staged changes", "Changes analyzed", async () => undefined);
  view.ui.cancel();
  assert.match(view.text(), /Detected 1 staged file:/);
  assert.match(view.text(), /Changes analyzed in \d+\.\ds/);
  assert.match(view.text(), /Cancelled\. No commit was created\./);
  assert.equal(view.text().includes("\x1b"), false);
  assert.doesNotMatch(view.text(), /[○❯⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});
