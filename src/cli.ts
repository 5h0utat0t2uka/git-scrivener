#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  assertSnapshotUnchanged,
  DEFAULT_MAX_DIFF_BYTES,
  readStagedSnapshot,
  RepositoryError,
} from "./git.ts";
import { DEFAULT_MODEL, generateCandidate, GenerationError } from "./generate.ts";
import { assembleCommitMessage, MessageValidationError } from "./message.ts";
import { SecretScanError } from "./secrets.ts";
import { editMessage } from "./edit.ts";
import { InteractionError, reviewCandidate } from "./review.ts";
import { commitCandidate, CommitError } from "./commit.ts";
import { createUi } from "./ui.ts";

let ui: ReturnType<typeof createUi> | undefined;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        check: { type: "boolean" },
        plain: { type: "boolean" },
        model: { type: "string", default: DEFAULT_MODEL },
        "max-diff-bytes": { type: "string", default: String(DEFAULT_MAX_DIFF_BYTES) },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch {
    throw new RepositoryError("Invalid arguments. Run git scrivener --help for usage.");
  }

  if (values.help) {
    console.log(`Usage: git scrivener [options]

Generate an English Conventional Commit message from staged Git changes.

Options:
  -h, --help                  Show this help
  -v, --version               Show the version
      --check                 Inspect the staged diff without sending it
      --plain                 Use static output and typed action shortcuts
      --model <id>            OpenAI model (default: ${DEFAULT_MODEL})
      --max-diff-bytes <n>    Maximum diff size in bytes (default: ${DEFAULT_MAX_DIFF_BYTES})

Generation requires OPENAI_API_KEY and sends the inspected diff to OpenAI.
Files are never staged automatically. A commit requires explicit confirmation.`);
    return;
  }
  if (values.version) {
    const metadata = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
    };
    console.log(metadata.version);
    return;
  }

  const limit = values["max-diff-bytes"];
  if (limit === undefined || !/^\d+$/.test(limit)) {
    throw new RepositoryError("--max-diff-bytes must be a positive integer number of bytes.");
  }
  if (!values.check) {
    if (!process.env.OPENAI_API_KEY?.trim())
      throw new GenerationError("OPENAI_API_KEY is not set.");
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new InteractionError(
        "An interactive terminal is required. Use --check to inspect without generating.",
      );
    }
    ui = createUi(values.plain ? { plain: true } : {});
    ui.start();
  }
  const snapshot = await readStagedSnapshot({ maxDiffBytes: Number(limit) });
  if (values.check) {
    console.log(`Staged diff ready (${snapshot.diffBytes} bytes). No data was sent.`);
    return;
  }
  if (ui === undefined) throw new InteractionError("An interactive terminal is required.");
  const terminal = ui;
  terminal.files(snapshot.files);
  const candidate = await terminal.progress(
    "Analyzing staged changes",
    "Changes analyzed",
    async () =>
      assembleCommitMessage(
        await generateCandidate(snapshot.diff, {
          model: values.model,
          maxInputBytes: Number(limit),
        }),
      ),
  );
  const accepted = await reviewCandidate(candidate, {
    prompt: terminal.prompt,
    display: terminal.display,
    reportError: terminal.error,
    edit: (message) => editMessage(message),
    regenerate: async (previousCandidate) => {
      await assertSnapshotUnchanged(snapshot);
      return terminal.progress("Generating another candidate", "Candidate regenerated", async () =>
        assembleCommitMessage(
          await generateCandidate(snapshot.diff, {
            model: values.model,
            previousCandidate,
            maxInputBytes: Number(limit),
          }),
        ),
      );
    },
  });
  if (accepted === null) {
    terminal.cancel();
    return;
  }
  terminal.step("Committing with Git");
  const commitOutput = terminal.commitOutput();
  try {
    await commitCandidate(accepted, snapshot, commitOutput ? { onOutput: commitOutput.write } : {});
  } finally {
    commitOutput?.finish();
  }
  terminal.finish("Commit created.");
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof RepositoryError ||
    error instanceof GenerationError ||
    error instanceof SecretScanError ||
    error instanceof MessageValidationError ||
    error instanceof InteractionError ||
    error instanceof CommitError
      ? error.message
      : "An unexpected error occurred.";
  if (ui) {
    ui.error(message);
    ui.finish("Stopped.");
  } else console.error(`git-scrivener: ${message}`);
  process.exitCode = 1;
}
