import type { CommitCandidate } from "./generate.ts";

export const MAX_MESSAGE_BYTES = 64 * 1024;
export class MessageValidationError extends Error {}

const typePattern = /^[^\s():!]+$/u;
const scopePattern = /^[^()\r\n]+$/u;
const footerPattern = /^(BREAKING CHANGE|[^\s:#]+)(: | #)(.*)$/u;
const breakingLabelPattern = /^(BREAKING CHANGE|BREAKING-CHANGE)(?=:| #|$)/i;

export interface Footer {
  token: string;
  separator: ":" | "#";
  value: string;
}

export function validateCommitMessage(input: string) {
  if (Buffer.byteLength(input, "utf8") > MAX_MESSAGE_BYTES) {
    throw new MessageValidationError("The commit message exceeds the 65536-byte safety limit.");
  }
  const message = input.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!message.trim()) throw new MessageValidationError("The commit message is empty.");
  for (const character of message) {
    const code = character.charCodeAt(0);
    if (
      (code < 0x20 && character !== "\n" && character !== "\t") ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      throw new MessageValidationError("The commit message contains unsafe control characters.");
    }
  }

  const lines = message.split("\n");
  const subject = lines[0] ?? "";
  const header = /^([^\s():!]+)(?:\(([^()\r\n]+)\))?(!)?: (.+)$/u.exec(subject);
  if (!header || !header[4]?.trim() || (header[2] !== undefined && !header[2].trim())) {
    throw new MessageValidationError(
      "Use a Conventional Commit subject: type(scope)!: description.",
    );
  }
  if (lines.length > 1 && lines[1] !== "") {
    throw new MessageValidationError(
      "Separate the subject from the body or footers with a blank line.",
    );
  }

  const body: string[] = [];
  const footers: Footer[] = [];
  let current: Footer | undefined;
  for (const [index, line] of lines.slice(2).entries()) {
    const paragraphStart = index === 0 || lines[index + 1] === "";
    const canStartFooter = current !== undefined || paragraphStart;
    const footer = canStartFooter ? footerPattern.exec(line) : null;
    const breakingLabel = canStartFooter && breakingLabelPattern.test(line);
    if (
      breakingLabel &&
      (!footer ||
        !["BREAKING CHANGE", "BREAKING-CHANGE"].includes(footer[1] ?? "") ||
        footer[2] !== ": ")
    ) {
      throw new MessageValidationError(
        "Use uppercase BREAKING CHANGE: or BREAKING-CHANGE: followed by a description.",
      );
    }
    if (footer) {
      current = {
        token: footer[1] ?? "",
        separator: footer[2] === ": " ? ":" : "#",
        value: footer[3] ?? "",
      };
      footers.push(current);
    } else if (current !== undefined) {
      current.value += `\n${line}`;
    } else {
      body.push(line);
    }
  }
  if (footers.some((footer) => !footer.value.trim())) {
    throw new MessageValidationError("Every footer must have a nonempty value.");
  }

  return {
    message,
    type: header[1] ?? "",
    scope: header[2] ?? null,
    description: header[4],
    body: body.join("\n").replace(/\n+$/, "") || null,
    footers,
    breaking:
      header[3] === "!" ||
      footers.some(
        (footer) => footer.token === "BREAKING CHANGE" || footer.token === "BREAKING-CHANGE",
      ),
  };
}

export function assembleCommitMessage(candidate: CommitCandidate): string {
  if (!typePattern.test(candidate.type)) {
    throw new MessageValidationError("The generated type is invalid.");
  }
  if (
    candidate.scope !== null &&
    (!scopePattern.test(candidate.scope) || !candidate.scope.trim())
  ) {
    throw new MessageValidationError("The generated scope is invalid.");
  }
  if (!candidate.description.trim() || /[\r\n]/.test(candidate.description)) {
    throw new MessageValidationError("The generated description must be a nonempty single line.");
  }
  if (candidate.body !== null && !candidate.body.trim()) {
    throw new MessageValidationError("The generated body must be nonempty or null.");
  }
  if (
    candidate.breakingDescription !== null &&
    (!candidate.breaking || !candidate.breakingDescription.trim())
  ) {
    throw new MessageValidationError("The generated breaking-change fields are inconsistent.");
  }

  const scope = candidate.scope === null ? "" : `(${candidate.scope})`;
  const sections = [
    `${candidate.type}${scope}${candidate.breaking ? "!" : ""}: ${candidate.description}`,
  ];
  if (candidate.body !== null) sections.push(candidate.body);
  const footers: string[] = [];
  if (candidate.breakingDescription !== null) {
    footers.push(`BREAKING CHANGE: ${candidate.breakingDescription}`);
  }
  for (const footer of candidate.footers) {
    if (
      !/^[^\s:#]+$/u.test(footer.token) ||
      /^BREAKING(?: |-)CHANGE$/i.test(footer.token) ||
      !footer.value.trim()
    ) {
      throw new MessageValidationError(
        "A generated footer is invalid; use breakingDescription for breaking changes.",
      );
    }
    footers.push(`${footer.token}${footer.separator === ":" ? ": " : " #"}${footer.value}`);
  }
  if (footers.length > 0) sections.push(footers.join("\n"));
  const validated = validateCommitMessage(sections.join("\n\n"));
  if (validated.breaking !== candidate.breaking) {
    throw new MessageValidationError(
      "The generated body or footers contradict the breaking-change flag.",
    );
  }
  return validated.message;
}
