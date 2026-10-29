import assert from "node:assert/strict";
import test from "node:test";
import { EditorError } from "../src/edit.ts";
import { GenerationError } from "../src/generate.ts";
import { reviewCandidate } from "../src/review.ts";

function actions(choices: (string | null)[]) {
  const displayed: string[] = [];
  const errors: string[] = [];
  const regenerated: string[] = [];
  return {
    displayed,
    errors,
    regenerated,
    prompt: async () => choices.shift() ?? null,
    display: (message: string) => {
      displayed.push(message);
    },
    reportError: (message: string) => {
      errors.push(message);
    },
    edit: async () => "fix: edited candidate",
    regenerate: async (previous: string) => {
      regenerated.push(previous);
      return "feat: another candidate";
    },
  };
}

test("only an explicit confirm accepts the current candidate", async () => {
  for (const answer of ["c", "confirm", " CONFIRM "]) {
    assert.equal(await reviewCandidate("feat: original", actions([answer])), "feat: original");
  }
  for (const answer of ["", "q", "cancel", null]) {
    assert.equal(await reviewCandidate("feat: original", actions([answer])), null);
  }
});

test("editing alone never accepts the message", async () => {
  const ui = actions(["edit", "cancel"]);
  assert.equal(await reviewCandidate("feat: original", ui), null);
  assert.deepEqual(ui.displayed, ["feat: original", "fix: edited candidate"]);
});

test("editing followed by explicit confirm accepts the edited candidate", async () => {
  assert.equal(
    await reviewCandidate("feat: original", actions(["e", "c"])),
    "fix: edited candidate",
  );
});

test("regeneration uses the current candidate and returns to review", async () => {
  const ui = actions(["edit", "regenerate", "confirm"]);
  assert.equal(await reviewCandidate("feat: original", ui), "feat: another candidate");
  assert.deepEqual(ui.regenerated, ["fix: edited candidate"]);
  assert.equal(ui.displayed.length, 3);
});

test("a failed or invalid edit retains the old candidate without confirming", async () => {
  for (const edit of [
    async () => "",
    async () => "invalid message",
    async () => {
      throw new EditorError("Editor failed.");
    },
  ]) {
    const ui = { ...actions(["edit", "cancel"]), edit };
    assert.equal(await reviewCandidate("feat: original", ui), null);
    assert.deepEqual(ui.displayed, ["feat: original", "feat: original"]);
    assert.ok(ui.errors.length > 0);
  }
});

test("a regeneration failure preserves the current candidate and still requires confirmation", async () => {
  const ui = {
    ...actions(["regenerate", "confirm"]),
    regenerate: async () => {
      throw new GenerationError("OpenAI request failed.");
    },
  };
  assert.equal(await reviewCandidate("feat: original", ui), "feat: original");
  assert.match(ui.errors.join("\n"), /previous candidate is retained/);
});

test("invalid actions do not confirm and unexpected errors are not echoed", async () => {
  const ui = {
    ...actions(["yes", "edit", "cancel"]),
    edit: async () => {
      throw new Error("PRIVATE_DATA");
    },
  };
  assert.equal(await reviewCandidate("feat: original", ui), null);
  assert.doesNotMatch(ui.errors.join("\n"), /PRIVATE_DATA/);
  assert.equal(ui.displayed.length, 3);
});
