import { isUtf8 } from "node:buffer";
import { stdin, stdout, stderr } from "node:process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { SelectPrompt, wrapTextWithPrefix } from "@clack/core";
import {
  S_BAR,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  SELECT_INSTRUCTIONS,
  cancel,
  formatInstructionFooter,
  intro,
  isCancel,
  limitOptions,
  log,
  outro,
  spinner,
  unicodeOr,
  updateSettings,
} from "@clack/prompts";

// Treat Ctrl-D as cancellation in raw-mode menus as well as line-oriented input.
updateSettings({ aliases: { "\x04": "cancel" } });

const stepSymbol = unicodeOr("○", "o");

function displayPath(path: Buffer): string {
  if (!isUtf8(path)) {
    return `"${Array.from(path, (byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("")}"`;
  }
  const value = path.toString("utf8");
  // Escape control/format characters, including newlines, ANSI escapes, and bidi controls.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    return JSON.stringify(value).replace(
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
      (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
    );
  }
  return value;
}

export function createUi({
  plain = process.env.TERM === "dumb" || /^(1|true)$/i.test(process.env.ACCESSIBLE ?? ""),
  input = stdin,
  output = stdout,
  errorOutput = stderr,
}: {
  plain?: boolean;
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
} = {}) {
  const options = { output, withGuide: true };
  const elapsed = (start: number) => `${((performance.now() - start) / 1_000).toFixed(1)}s`;

  function step(message: string, spacing = 1) {
    if (plain) output.write(`${message}\n`);
    else {
      log.message(message, {
        ...options,
        symbol: styleText("green", stepSymbol),
        spacing,
      });
    }
  }

  return {
    start() {
      if (plain) output.write("git-scrivener\n");
      else intro(styleText("inverse", " git-scrivener "), options);
    },
    files(paths: readonly Buffer[]) {
      const title = `👀 Detected ${paths.length} staged ${paths.length === 1 ? "file" : "files"}:`;
      const names = paths.map((path) => `   ${displayPath(path)}`).join("\n");
      if (plain) output.write(`${title}\n${names}\n`);
      else step(`${title}\n${styleText("dim", names)}`);
    },
    display(message: string) {
      if (plain) output.write(`\n${message}\n\n`);
      else log.message(message, options);
    },
    error(message: string) {
      if (plain) errorOutput.write(`${message}\n`);
      else log.error(message, { output: errorOutput, withGuide: true });
    },
    step,
    commitOutput() {
      // Plain mode leaves Git and interactive hooks connected directly to the terminal.
      if (plain) return undefined;
      const guide = styleText("gray", S_BAR);
      let atLineStart = true;
      let afterCarriageReturn = false;
      return {
        write(chunk: string) {
          // Emit partial lines immediately, including prompts that have no trailing newline.
          for (const part of chunk.split(/(\r|\n)/)) {
            if (!part) continue;
            if (part === "\r") {
              output.write("\r");
              atLineStart = true;
              afterCarriageReturn = true;
            } else if (part === "\n") {
              if (atLineStart && !afterCarriageReturn) output.write(guide);
              output.write("\n");
              atLineStart = true;
              afterCarriageReturn = false;
            } else {
              if (atLineStart) output.write(`${guide}  `);
              output.write(part);
              atLineStart = false;
              afterCarriageReturn = false;
            }
          }
        },
        finish() {
          if (!atLineStart || afterCarriageReturn) output.write("\n");
          atLineStart = true;
          afterCarriageReturn = false;
        },
      };
    },
    finish(message: string) {
      if (plain) output.write(`${message}\n`);
      else outro(message, options);
    },
    cancel() {
      const message = "Cancelled. No commit was created.";
      if (plain) output.write(`${message}\n`);
      else cancel(message, options);
    },
    async progress<T>(label: string, completed: string, task: () => Promise<T>): Promise<T> {
      const started = performance.now();
      const indicator = plain
        ? undefined
        : spinner({
            ...options,
            frames: [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"],
            delay: 80,
            cancelMessage: "Cancelled. No commit was created.",
            errorMessage: "Generation stopped.",
            // A signal must also stop the task, not just its animation.
            onCancel: () => process.exit(130),
          });
      if (indicator) indicator.start(label);
      else output.write(`${label}...\n`);
      try {
        const result = await task();
        const message = `${completed} in ${elapsed(started)}`;
        // clear() stops the animation and restores the terminal without a fixed success symbol.
        // The spinner already printed the guide line, so do not add another one here.
        indicator?.clear();
        step(message, 0);
        return result;
      } catch (error) {
        const message = `Generation failed after ${elapsed(started)}`;
        if (indicator) indicator.error(message);
        else output.write(`${message}\n`);
        throw error;
      } finally {
        indicator?.clear();
      }
    },
    async prompt(): Promise<string | null> {
      if (input.readableEnded || input.destroyed) return null;
      if (plain) {
        return new Promise((resolve) => {
          const readline = createInterface({ input, output, terminal: false });
          let finished = false;
          function finish(answer: string | null) {
            if (finished) return;
            finished = true;
            process.off("SIGINT", interrupt);
            readline.close();
            resolve(answer);
          }
          const interrupt = () => finish(null);
          process.once("SIGINT", interrupt);
          readline.once("SIGINT", interrupt);
          readline.once("close", interrupt);
          readline.question(
            "[c]onfirm / [e]dit / [r]egenerate / [q]cancel (default: cancel): ",
            finish,
          );
        });
      }
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      input.once("end", interrupt);
      input.once("close", interrupt);
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      try {
        // Keep Clack's input handling and customize only the rendered timeline.
        const choice = await new SelectPrompt({
          output,
          input,
          signal: controller.signal,
          initialValue: "confirm",
          options: [
            { value: "confirm", label: "Confirm", hint: "Create the commit" },
            { value: "edit", label: "Edit", hint: "Open Git's editor" },
            { value: "regenerate", label: "Regenerate", hint: "Request another message" },
            { value: "cancel", label: "Cancel", hint: "Keep staged changes" },
          ],
          render() {
            const color =
              this.state === "cancel" ? "red" : this.state === "submit" ? "green" : "cyan";
            const title = `${styleText("gray", S_BAR)}\n${styleText(
              color,
              wrapTextWithPrefix(
                output,
                "Use this commit message?",
                `${S_BAR}  `,
                `${stepSymbol}  `,
              ),
            )}\n`;
            if (this.state === "submit" || this.state === "cancel") {
              const label =
                this.state === "cancel" ? "Cancelled" : this.options[this.cursor]!.label;
              return `${title}${wrapTextWithPrefix(
                output,
                styleText("dim", label),
                `${styleText("gray", S_BAR)}  `,
              )}`;
            }
            const prefix = `${styleText("cyan", S_BAR)}  `;
            const footer = formatInstructionFooter(SELECT_INSTRUCTIONS, true);
            const choices = limitOptions({
              output,
              options: this.options,
              cursor: this.cursor,
              columnPadding: 3,
              rowPadding: title.split("\n").length + footer.length,
              style: (option, active) =>
                active
                  ? `${styleText("green", S_RADIO_ACTIVE)} ${option.label} ${styleText("dim", `(${option.hint})`)}`
                  : styleText("dim", `${S_RADIO_INACTIVE} ${option.label}`),
            });
            return `${title}${prefix}${choices.join(`\n${prefix}`)}\n${footer.join("\n")}`;
          },
        }).prompt();
        return isCancel(choice) ? null : (choice ?? null);
      } finally {
        input.off("end", interrupt);
        input.off("close", interrupt);
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
      }
    },
  };
}
