```txt
▘▗         ▘          
▛▌▌▜▘  ▛▘▛▘▛▘▌▌▌█▌▛▌█▌▛▘
▙▌▌▐▖  ▄▌▙▖▌ ▌▚▘▙▖▌▌▙▖▌ 
▄▌                                                                                                                                 
```

# git-scrivener

A personal CLI for generating English Conventional Commit messages from staged Git changes using OpenAI.

## Usage

With `git-scrivener` on `PATH` and `OPENAI_API_KEY` provided by your runtime environment:

```sh
git add <files>
git scrivener
```

Use `git scrivener --model <id>` to change the model, or `git scrivener --check` to inspect staged changes without an API request.

The CLI generates and validates a Conventional Commit candidate from staged changes, then offers confirmation, editing, regeneration, and cancellation. Explicit confirmation runs `git commit --file` using the accepted message. Use `--check` for staged-diff inspection without an API request.

- Reads only the index, including initial commits and partially staged files.
- Rejects an empty diff, unresolved conflicts, non-UTF-8 text, and diffs exceeding the configured byte limit.
- Disables external diff and textconv commands and checks for HEAD or index changes during inspection.
- Does not stage files automatically. Inspection, editing, and cancellation leave staged contents and working files unchanged. `git write-tree` may create tree objects and update Git's index cache.
- Prints the diff size without printing the patch. Binary files use Git's binary-change summary.

## Development

```sh
direnv allow
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
node dist/cli.js --help
```

Node.js 24 from the locked nixpkgs revision (currently 24.21.0) and pnpm 10.34.9 are supplied by the Nix development shell. Both use Nixpkgs package definitions; pnpm's version and source hash are overridden to match `packageManager`. Oxlint and Oxfmt also come from Nix. Tests use Node's built-in test runner and create isolated Git repositories under `.test-tmp/`; they do not use your signing configuration or hooks.

Generation tests use the official SDK with an in-memory HTTP transport and synthetic credentials. They require Betterleaks from the development shell, but do not contact OpenAI or validate credentials against provider APIs.

Inspect the currently staged changes during development:

```sh
pnpm dev --check
pnpm dev --check --max-diff-bytes 524288
```

The default limit is 1,048,576 bytes for the complete UTF-8 diff, including patch headers. This is a CLI size policy, not a model context-window guarantee. The patch is never silently truncated.

To generate a candidate, provide `OPENAI_API_KEY` through your runtime environment, then run `pnpm dev`. Use `pnpm dev --model <id>` to select another model supporting Responses and Structured Outputs. The same byte limit applies to the JSON-encoded input, so escaping and regeneration context can cause a request to exceed the limit even when the raw diff fits.

Generation requires an interactive terminal. A timeline displays staged file paths, a spinner during generation or regeneration, and the elapsed processing time. The duration includes the secret scan, API request, and candidate validation. Filenames containing terminal controls or non-UTF-8 bytes are escaped for display.

Timeline steps and review questions use `○`. This marker is defined in `src/ui.ts`; the selection menu uses Clack Core's public render API while Clack handles keyboard input and terminal restoration.

Use the up/down arrows to choose **Confirm**, **Edit**, **Regenerate**, or **Cancel**, then press Enter. Confirm is initially selected each time the menu opens, so pressing Enter accepts the displayed candidate and starts the commit. Ctrl-C, Ctrl-D, Escape, or EOF at the selection menu cancel. Saving an edit or regenerating returns to this menu and still requires pressing Enter to confirm. Failed edits and failed regeneration keep the previous candidate visible for an explicit decision. The menu restores normal terminal input before launching the editor or Git; hooks and signing prompts run without a spinner.

Use `--plain` for static output and typed shortcuts (`c`, `e`, `r`, or `q` followed by Enter), suitable for screen readers or terminals without cursor control. An empty answer, EOF, or Ctrl-C cancels in this mode. Plain mode is also enabled by `TERM=dumb` or `ACCESSIBLE=1`/`true`. `NO_COLOR=1` disables colors while retaining the interactive menu and spinner.

The editor comes from `git var GIT_EDITOR`, including configured arguments and quoting, and runs using Git's POSIX shell from `git var GIT_SHELL_PATH`. Its message file starts with mode `0600` in a private `0700` temporary directory and is removed when editing finishes. Edited messages are read with a size bound, rejected if they are symlinks or have additional hard links, and validated before replacing the candidate. Saving and quitting the editor returns to review.

Immediately before committing or regenerating, the CLI checks that HEAD, its branch reference, and the index tree still match the generation snapshot. A mismatch ends the operation and requires a fresh invocation. This check is not an atomic lock against other Git processes; avoid changing the index or branch concurrently. Git hooks can themselves change the index or commit message.

Commits use the configured Git hooks and signing settings, including SSH signing. Hook or signing failures stop the operation without an unsigned retry or an index reset. The API key is removed from the environment passed to the editor and commit process. Tests cover hook execution and simulated SSH signing failure; live OpenAI access and physical YubiKey signing still need an end-to-end check in the target environment.

Git's standard output and standard error, including hook results, are merged into one stream and displayed with a `│` guide. Partial lines are displayed immediately, and indentation is preserved. Input remains connected to the terminal, and signing programs can still use `/dev/tty`. Prompts written directly to `/dev/tty` are outside the captured stream and are not decorated. In the decorated mode, Git and hook output descriptors are pipes rather than TTYs; use `--plain` for hooks requiring terminal output or full-screen controls. Plain mode leaves all three descriptors connected directly to the terminal.

The package declares the executable name `git-scrivener`, for invocation as `git scrivener` once installed on `PATH`.

## Nix package

`nix/package.nix` defines the package, exported as `packages.<system>.git-scrivener` and `packages.<system>.default`. The complete Nix build has passed on aarch64-darwin, including type checking, lint, the test suite, and installed CLI help/version checks.

Build and inspect the package:

```sh
nix build .#git-scrivener
./result/bin/git-scrivener --help
nix run .#git-scrivener -- --version
```

To use Git's external-command dispatch with the local build:

```sh
PATH="$PWD/result/bin:$PATH" git scrivener --version
```

The package uses the same pinned Node.js and pnpm as the development shell. `fetchPnpmDeps` downloads the lockfile dependencies; subsequent installation, compilation, and tests run offline. The build runs type checking, lint, and the test suite, then installs compiled JavaScript, package metadata, and production dependencies. Its launcher supplies Git and Betterleaks and keeps the user's environment available for the editor, SSH agent, signing program, and hooks.

Build sources are limited to TypeScript source/tests and named build configuration files. The dependency fetcher receives only the package manifest, lockfile, and workspace configuration. API keys are never read during Nix evaluation or builds; provide them only at runtime. When building a local Git flake, new source files must be known to Git. Keep secrets untracked: the flake itself is copied to the Nix store before the package's source filter runs.

The later chezmoi integration can consume `inputs.git-scrivener.packages.${system}.default`. SOPS key management and runtime environment setup belong to that project.

## API generation policy

- Uses the official OpenAI SDK, Responses API, and Zod Structured Outputs. The default model is `gpt-6-luna`; `--model` accepts an explicit model override.
- Reads `OPENAI_API_KEY` at runtime, fixes the endpoint to `https://api.openai.com/v1`, disables SDK logging and HTTP redirects, and does not automatically retry requests.
- Sets `store: false` and disables input truncation. `store: false` is not a guarantee of zero data retention; see [OpenAI's data controls](https://developers.openai.com/api/docs/guides/your-data).
- Keeps generation instructions separate from the untrusted diff and previous candidate. The JSON-encoded input has a separate byte-limit check, including the previous candidate when regenerating.
- Scans all outgoing diff lines and any previous candidate with Betterleaks before making a request. The scanner uses its embedded rules in an isolated temporary directory, ignores target-repository overrides and inline allow comments, and performs no live credential validation. Scan errors block the request. The diff is passed through stdin, not written to the temporary directory.
- Secret detection is heuristic and does not establish that arbitrary data is safe to share. API errors, refusals, malformed output, and incomplete responses are rejected without printing their raw contents.

## Message validation

Messages support optional scopes, multi-paragraph bodies, multiline footer values, `!`, `BREAKING CHANGE:`, and `BREAKING-CHANGE:`. Types are case-insensitive and are not restricted to a fixed list. No subject length limit is imposed. Validation checks structure, not whether a chosen type accurately describes the code change.

The CLI separately rejects unsafe terminal control characters and messages larger than 65,536 bytes. These are safety policies, not Conventional Commits requirements. CRLF and trailing newlines are normalized. As in the specification, a footer token and separator start a footer section after a blank line; otherwise body text remains free-form.

## Project-local skills

```sh
nix run --no-write-lock-file .#skills-install-local
```

Skills are copied into the generated, Git-ignored `.agents/skills/` directory. No skills are selected yet.

## References

- [Git diff](https://git-scm.com/docs/git-diff)
- [Git write-tree](https://git-scm.com/docs/git-write-tree)
- [Git editor resolution](https://git-scm.com/docs/git-var)
- [Git commit](https://git-scm.com/docs/git-commit)
- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- [Node.js TypeScript support](https://nodejs.org/docs/latest-v24.x/api/typescript.html)
- [Node.js test runner](https://nodejs.org/docs/latest-v24.x/api/test.html)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Nixpkgs pnpm packaging](https://github.com/NixOS/nixpkgs/blob/master/doc/languages-frameworks/javascript.section.md#pnpm-javascript-pnpm)
- [pnpm installation options](https://pnpm.io/10.x/cli/install)
- [Nix flakes](https://nix.dev/concepts/flakes)
- [Clack prompts](https://github.com/bombshell-dev/clack/tree/main/packages/prompts)
- [Clack Core custom rendering](https://github.com/bombshell-dev/clack/tree/main/packages/core)
