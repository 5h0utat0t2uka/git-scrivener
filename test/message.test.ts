import assert from "node:assert/strict";
import test from "node:test";
import type { CommitCandidate } from "../src/generate.ts";
import { assembleCommitMessage, MAX_MESSAGE_BYTES, validateCommitMessage } from "../src/message.ts";

const candidate: CommitCandidate = {
  type: "feat",
  scope: null,
  description: "inspect staged changes",
  body: null,
  breaking: false,
  breakingDescription: null,
  footers: [],
};

test("assembles an optional scope, body, breaking marker, and footers", () => {
  const message = assembleCommitMessage({
    ...candidate,
    scope: "cli",
    body: "Read only staged changes.\n\nKeep working-tree edits out of the request.",
    breaking: true,
    breakingDescription: "Remove the old invocation.\nUse git scrivener instead.",
    footers: [
      { token: "Reviewed-by", separator: ":", value: "A Reviewer" },
      { token: "Refs", separator: "#", value: "123" },
    ],
  });
  assert.equal(
    message,
    [
      "feat(cli)!: inspect staged changes",
      "",
      "Read only staged changes.",
      "",
      "Keep working-tree edits out of the request.",
      "",
      "BREAKING CHANGE: Remove the old invocation.",
      "Use git scrivener instead.",
      "Reviewed-by: A Reviewer",
      "Refs #123",
    ].join("\n"),
  );
  const parsed = validateCommitMessage(message);
  assert.equal(parsed.breaking, true);
  assert.equal(parsed.footers.length, 3);
  assert.equal(parsed.footers[0]?.value, "Remove the old invocation.\nUse git scrivener instead.");
  assert.equal(
    parsed.body,
    "Read only staged changes.\n\nKeep working-tree edits out of the request.",
  );
});

test("supports each breaking-change form, including the hyphenated footer alias", () => {
  for (const message of [
    "feat!: change the interface",
    "feat(api)!: change the interface",
    "feat: change the interface\n\nBREAKING CHANGE: remove the old method",
    "feat: change the interface\n\nBREAKING-CHANGE: remove the old method",
    "feat!: change the interface\n\nBREAKING CHANGE: remove the old method",
  ]) {
    assert.equal(validateCommitMessage(message).breaking, true);
  }
});

test("accepts custom types, mixed case, and long subjects without imposing a type list", () => {
  assert.equal(validateCommitMessage("SECURITY(api/client): improve validation").type, "SECURITY");
  assert.equal(validateCommitMessage("Feat: support a new feature").breaking, false);
  assert.doesNotThrow(() =>
    validateCommitMessage(`maintenance: ${"long description ".repeat(20)}`),
  );
});

test("accepts free-form multi-paragraph bodies and multiline footer values", () => {
  const parsed = validateCommitMessage(
    [
      "fix: preserve the selected files",
      "",
      "First paragraph.",
      "A continuation line.",
      "",
      "Second paragraph.",
      "",
      "Reviewed-by: First Reviewer",
      "Second Reviewer",
      "",
      "More review context.",
      "Refs: #123",
      "Refs #456",
    ].join("\n"),
  );
  assert.equal(parsed.body, "First paragraph.\nA continuation line.\n\nSecond paragraph.");
  assert.deepEqual(parsed.footers, [
    {
      token: "Reviewed-by",
      separator: ":",
      value: "First Reviewer\nSecond Reviewer\n\nMore review context.",
    },
    { token: "Refs", separator: ":", value: "#123" },
    { token: "Refs", separator: "#", value: "456" },
  ]);
});

test("normalizes CRLF and trailing newlines when reading an edited message", () => {
  assert.equal(
    validateCommitMessage("docs: improve help\r\n\r\nExplain the flags.\r\n").message,
    "docs: improve help\n\nExplain the flags.",
  );
});

test("rejects empty messages and malformed subjects", () => {
  for (const message of [
    "",
    " \n\t",
    "plain message",
    "feat:missing space",
    "feat: ",
    "feat(): empty scope",
    "feat( ): whitespace scope",
    "feat!(cli): misplaced marker",
    "feat(cli: missing parenthesis",
    "feat: subject\nbody without separation",
    "\nfeat: leading blank line",
  ]) {
    assert.throws(() => validateCommitMessage(message));
  }
});

test("rejects malformed breaking footers and empty footer values", () => {
  for (const footer of [
    "breaking change: remove the method",
    "breaking-change: remove the method",
    "BREAKING CHANGE:missing space",
    "BREAKING CHANGE #remove the method",
    "BREAKING CHANGE:",
    "BREAKING CHANGE: ",
    "Refs: ",
  ]) {
    assert.throws(() => validateCommitMessage(`feat: change the interface\n\n${footer}`));
  }
});

test("rejects terminal control characters and messages over the separate byte safety limit", () => {
  for (const code of [0, 13, 27, 127, 0x9b, 0x202e, 0x2066]) {
    assert.throws(
      () => validateCommitMessage(`fix: safe${String.fromCharCode(code)}text`),
      /control/,
    );
  }
  assert.throws(
    () => validateCommitMessage(`fix: ${"a".repeat(MAX_MESSAGE_BYTES)}`),
    /safety limit/,
  );
});

test("validates generated fields before assembling them", () => {
  for (const change of [
    { type: "feat(other)" },
    { scope: "cli)" },
    { scope: "" },
    { description: "first line\nsecond line" },
    { description: " " },
    { body: "" },
    { breakingDescription: "remove a method" },
    { body: "BREAKING CHANGE: remove a method" },
    { footers: [{ token: "Reviewed by", separator: ":" as const, value: "Reviewer" }] },
    { footers: [{ token: "Refs", separator: ":" as const, value: "" }] },
  ]) {
    assert.throws(() => assembleCommitMessage({ ...candidate, ...change }));
  }
});

test("allows a generated breaking marker without a redundant breaking footer", () => {
  assert.equal(
    assembleCommitMessage({ ...candidate, breaking: true }),
    "feat!: inspect staged changes",
  );
});
