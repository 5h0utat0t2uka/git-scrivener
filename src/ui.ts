import { isUtf8 } from "node:buffer";
import { stdin, stdout, stderr } from "node:process";
import { createInterface, emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ReadStream } from "node:tty";
import { styleText } from "node:util";
import { getColumns, SelectPrompt, wrapTextWithPrefix } from "@clack/core";
import {
  S_BAR,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  S_STEP_ERROR,
  SELECT_INSTRUCTIONS,
  cancel,
  formatInstructionFooter,
  isCancel,
  limitOptions,
  log,
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

  function startSpinner(label: string): () => void {
    const frames = [...unicodeOr("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏", "|/-\\")];
    const terminalInput = input as ReadStream;
    const rawInput = terminalInput.isTTY && typeof terminalInput.setRawMode === "function";
    const wasRaw = terminalInput.isRaw ?? false;
    const wasFlowing = input.readableFlowing === true;
    let timer: ReturnType<typeof setInterval> | undefined;
    let frame = 0;
    let active = true;
    const symbol = () => styleText("magenta", frames[frame]!);

    function renderLabel() {
      // Labels are fixed English strings. Keep them on one row, leaving the last
      // column unused so the cursor stays on the spinner even in narrow terminals.
      const available = Math.max(0, getColumns(output) - 4);
      const text =
        label.length <= available
          ? label
          : available > 0
            ? `${label.slice(0, available - 1)}${unicodeOr("…", ".")}`
            : "";
      output.write(`\r\x1b[0J${symbol()}${text ? `  ${text}` : ""}\r`);
    }

    function stop() {
      if (!active) return;
      active = false;
      clearInterval(timer);
      output.off("resize", renderLabel);
      input.off("keypress", keypress);
      input.off("end", interrupt);
      input.off("close", interrupt);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.off("exit", stop);
      if (rawInput) terminalInput.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
      output.write("\r\x1b[0J\x1b[?25h");
    }

    function interrupt() {
      stop();
      cancel("Cancelled. No commit was created.", options);
      // Stop the pending task as well as the animation.
      process.exit(130);
    }

    function terminate() {
      stop();
      cancel("Cancelled. No commit was created.", options);
      process.exit(143);
    }

    function keypress(_text: string | undefined, key: Key) {
      if (["\x03", "\x04", "\x1b"].includes(key.sequence ?? "")) interrupt();
    }

    try {
      process.once("exit", stop);
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", terminate);
      input.once("end", interrupt);
      input.once("close", interrupt);
      emitKeypressEvents(input);
      input.on("keypress", keypress);
      if (rawInput) terminalInput.setRawMode(true);
      input.resume();
      output.write(`${styleText("gray", S_BAR)}\n\x1b[?25l`);
      renderLabel();
      output.on("resize", renderLabel);
      timer = setInterval(() => {
        frame = (frame + 1) % frames.length;
        // Only replace the first cell; never erase or reprint the label per frame.
        output.write(`${symbol()}\r`);
      }, 80);
      return stop;
    } catch (error) {
      stop();
      throw error;
    }
  }

  return {
    start() {
      if (!plain) output.write("\n");
    },
    files(paths: readonly Buffer[]) {
      const title = `👀 Detected ${paths.length} staged ${paths.length === 1 ? "file" : "files"}:`;
      const names = paths.map((path) => `   ${displayPath(path)}`).join("\n");
      if (plain) output.write(`${title}\n${names}\n`);
      else step(`${title}\n${styleText("dim", names)}`, 0);
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
      else {
        log.message(message, { ...options, symbol: styleText("gray", stepSymbol) });
        output.write("\n");
      }
    },
    cancel() {
      const message = "Cancelled. No commit was created.";
      if (plain) output.write(`${message}\n`);
      else cancel(message, options);
    },
    async progress<T>(label: string, completed: string, task: () => Promise<T>): Promise<T> {
      const started = performance.now();
      const stop = plain ? undefined : startSpinner(label);
      if (plain) output.write(`${label}...\n`);
      try {
        const result = await task();
        const message = `${completed} in ${elapsed(started)}`;
        stop?.();
        step(message, 0);
        return result;
      } catch (error) {
        const message = `Generation failed after ${elapsed(started)}`;
        stop?.();
        if (plain) output.write(`${message}\n`);
        else
          log.message(message, { ...options, symbol: styleText("red", S_STEP_ERROR), spacing: 0 });
        throw error;
      } finally {
        stop?.();
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
