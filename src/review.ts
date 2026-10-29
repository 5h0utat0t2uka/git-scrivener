import { EditorError } from "./edit.ts";
import { GenerationError } from "./generate.ts";
import { MessageValidationError, validateCommitMessage } from "./message.ts";
import { SecretScanError } from "./secrets.ts";
import { RepositoryError } from "./git.ts";

export class InteractionError extends Error {}

interface ReviewActions {
  prompt: () => Promise<string | null>;
  display: (message: string) => void;
  reportError: (message: string) => void;
  edit: (message: string) => Promise<string>;
  regenerate: (previous: string) => Promise<string>;
}

export async function reviewCandidate(
  initialMessage: string,
  actions: ReviewActions,
): Promise<string | null> {
  let message = validateCommitMessage(initialMessage).message;
  while (true) {
    actions.display(message);
    const choice = (await actions.prompt())?.trim().toLowerCase() ?? "";
    if (["", "q", "cancel"].includes(choice)) return null;
    if (["c", "confirm"].includes(choice)) return validateCommitMessage(message).message;
    if (!["e", "edit", "r", "regenerate"].includes(choice)) {
      actions.reportError("Choose confirm, edit, regenerate, or cancel.");
      continue;
    }
    try {
      const updated = ["e", "edit"].includes(choice)
        ? await actions.edit(message)
        : await actions.regenerate(message);
      message = validateCommitMessage(updated).message;
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      const known =
        error instanceof EditorError ||
        error instanceof GenerationError ||
        error instanceof SecretScanError ||
        error instanceof MessageValidationError;
      actions.reportError(known ? error.message : "The operation failed.");
      actions.reportError(
        "The previous candidate is retained. Confirm explicitly to accept it, or cancel.",
      );
    }
  }
}
