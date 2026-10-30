import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import type { TestContext } from "node:test";
import { createUi } from "../src/ui.ts";

function terminal(t: TestContext, plain = false) {
  let text = "";
  const chunks: string[] = [];
  const modes: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(enabled: boolean) {
      this.isRaw = enabled;
      modes.push(enabled);
    },
  });
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        const value = chunk.toString();
        chunks.push(value);
        text += value;
        callback();
      },
    }),
    { columns: 80 },
  );
  t.after(() => {
    input.destroy();
    output.destroy();
  });
  return {
    input,
    output,
    chunks,
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
  assert.match(text, /○  Candidate regenerated in \d+\.\ds\n/);
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
    assert.equal(view.input.isRaw, false);
    assert.equal(view.input.isPaused(), true);
    assert.equal(view.input.listenerCount("keypress"), 0);
    assert.equal(view.output.listenerCount("resize"), 0);
    assert.ok(view.text().includes("\x1b[?25h"));
    assert.deepEqual(
      signals.map((signal) => process.listenerCount(signal)),
      listeners,
    );
  }
});

test("spinner frames leave the label visible and stop writing after completion", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const task = Promise.withResolvers<string>();
  let result: Promise<string>;
  t.after(async () => {
    task.resolve("candidate");
    await result;
  });
  const view = terminal(t);
  result = view.ui.progress("Analyzing staged changes", "Changes analyzed", () => task.promise);
  const initial = view.chunks.length;
  t.mock.timers.tick(240);
  const updates = view.chunks.slice(initial).map(stripVTControlCharacters);
  assert.equal(updates.length, 3);
  for (const update of updates) {
    assert.match(update, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\r$/u);
  }
  assert.equal(view.text().split("Analyzing staged changes").length - 1, 1);
  for (const chunk of view.chunks.slice(initial)) {
    assert.equal(chunk.includes("\x1b[0J"), false, "do not erase the label between frames");
  }
  task.resolve("candidate");
  assert.equal(await result, "candidate");
  const finished = view.text();
  t.mock.timers.tick(240);
  assert.equal(view.text(), finished);
});

test("spinner redraws the label only on resize and keeps it within one terminal row", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const task = Promise.withResolvers<void>();
  let result: Promise<void>;
  t.after(async () => {
    task.resolve();
    await result;
  });
  const view = terminal(t);
  result = view.ui.progress("Analyzing staged changes", "Changes analyzed", () => task.promise);
  for (const columns of [16, 4, 1, 80]) {
    view.output.columns = columns;
    view.output.emit("resize");
    const label = stripVTControlCharacters(view.chunks.at(-1)!).replaceAll("\r", "");
    assert.ok([...label].length <= Math.max(1, columns - 1));
    assert.equal(label.includes("\n"), false);
    if (columns === 16) assert.ok(label.endsWith("…"));
    if (columns === 80) assert.ok(label.endsWith("Analyzing staged changes"));
    const beforeTick = view.chunks.length;
    t.mock.timers.tick(80);
    assert.equal(view.chunks.length, beforeTick + 1);
    assert.match(stripVTControlCharacters(view.chunks.at(-1)!), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\r$/u);
  }
  task.resolve();
  await result;
});

test("spinner cancellation stops the task and restores terminal state", { timeout: 15_000 }, () => {
  for (const [action, expectedCode] of [
    ['input.write("\\x03")', 130],
    ['input.write("\\x04")', 130],
    ['input.write("\\x1b")', 130],
    ["input.end()", 130],
    ['process.kill(process.pid, "SIGINT")', 130],
    ['process.kill(process.pid, "SIGTERM")', 143],
  ] as const) {
    const source = `
import { PassThrough, Writable } from "node:stream";
import { createUi } from ${JSON.stringify(new URL("../src/ui.ts", import.meta.url).href)};
const input = Object.assign(new PassThrough(), {
  isTTY: true,
  isRaw: false,
  setRawMode(value) { this.isRaw = value; },
});
const output = Object.assign(new Writable({
  write(chunk, encoding, callback) { process.stdout.write(chunk); callback(); },
}), { columns: 80 });
process.once("exit", () => {
  process.stdout.write("\\nCLEANUP:" + JSON.stringify({
    raw: input.isRaw,
    keys: input.listenerCount("keypress"),
    resize: output.listenerCount("resize"),
    paused: input.isPaused(),
  }) + "\\n");
});
void createUi({ plain: false, input, output }).progress(
  "Analyzing staged changes", "Changes analyzed", () => new Promise(() => {}),
);
setImmediate(() => { ${action}; });
`;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
      env: { ...process.env, OPENAI_API_KEY: "" },
      timeout: 2_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, expectedCode, `${action}: ${child.stderr}`);
    assert.match(child.stdout, /Cancelled\. No commit was created\./);
    assert.ok(child.stdout.includes("\x1b[?25h"));
    assert.ok(child.stdout.includes('CLEANUP:{"raw":false,"keys":0,"resize":0,"paused":true}'));
    assert.doesNotMatch(child.stdout, /Changes analyzed in/);
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
