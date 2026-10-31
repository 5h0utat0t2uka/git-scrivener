# Home Manager

The flake exports `homeManagerModules.default` and the equivalent `homeManagerModules.git-scrivener`. The module supports Home Manager standalone and Home Manager used through NixOS or nix-darwin.

Add this input to the consumer's flake:

```nix
inputs.git-scrivener.url = "github:5h0utat0t2uka/git-scrivener";
```

Import the module in the **Home Manager** module list, rather than directly in the NixOS or nix-darwin system module list:

```nix
{ inputs, ... }:
{
  imports = [ inputs.git-scrivener.homeManagerModules.default ];

  programs.git-scrivener = {
    enable = true;
    provider = "openai";
    language = "en";
    model = "gpt-6-luna";
  };
}
```

This example assumes `inputs` is passed to your Home Manager modules. With NixOS/nix-darwin, use `home-manager.extraSpecialArgs = { inherit inputs; };` in the enclosing flake configuration. With standalone Home Manager, use `extraSpecialArgs = { inherit inputs; };` in `home-manager.lib.homeManagerConfiguration`. If the import is written directly inside the flake's outputs, you can use the existing lexical `inputs` binding instead.

The module installs a wrapper named `git-scrivener`, so invocation remains `git scrivener`. It selects the package exported by this flake for the host system. No overlay is required, and the package uses this flake's pinned build dependencies by default.

## Options

| Option under `programs.git-scrivener` | Default | Meaning |
| --- | --- | --- |
| `enable` | `false` | Install the configured CLI. |
| `package` | This flake's `packages.<system>.git-scrivener` | Package providing `bin/git-scrivener`; may also be a runtime key-loading wrapper. |
| `provider` | `"openai"` | `"openai"` or `"anthropic"`. |
| `language` | `"en"` | `"en"` or `"ja"`; affects generated commit messages, not the UI. |
| `model` | `null` | Use the CLI's default for the selected provider: `gpt-6-luna` for OpenAI or `claude-haiku-5-5` for Anthropic. |

For OpenAI with English messages, `programs.git-scrivener.enable = true;` alone is sufficient apart from the runtime API key. Set `provider = "anthropic";` to use Haiku 5.5, or also set `model` to select another model. Invalid providers/languages and empty or whitespace-padded model identifiers are rejected during evaluation.

Explicit command-line options take precedence over these defaults:

```sh
git scrivener --language ja
git scrivener --provider anthropic --model claude-haiku-5-5 --language ja
git scrivener --plain
```

When changing providers, supply the corresponding runtime API key. If you set an explicit `model` in Home Manager, override it as well when switching providers, as shown above. With `model = null`, the CLI selects the new provider's default automatically. Alternative models must be available to your account and support the provider's API and Structured Outputs. The module forwards arguments unchanged and uses `exec`, preserving the CLI's exit status and terminal input.

## Runtime API keys and SOPS

The module inherits `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from the environment. It does not read secret contents during Nix evaluation, provide an inline API-key option, or depend on SOPS. Key provisioning remains the consumer's responsibility.

If your existing SOPS setup provides a decrypted key file, keep that secret declaration and supply a key-loading `package`. This OpenAI example reads `config.sops.secrets.openai_api_key.path` only when the command runs:

```nix
{ config, inputs, lib, pkgs, ... }:
let
  scrivener = inputs.git-scrivener.packages.${pkgs.stdenv.hostPlatform.system}.git-scrivener;
in
{
  imports = [ inputs.git-scrivener.homeManagerModules.default ];

  # Keep the existing sops.secrets.openai_api_key declaration in your configuration.
  programs.git-scrivener = {
    enable = true;
    provider = "openai";
    language = "en";
    model = "gpt-6-luna";
    package = pkgs.writeShellApplication {
      name = "git-scrivener";
      text = ''
        OPENAI_API_KEY="$(< ${lib.escapeShellArg config.sops.secrets.openai_api_key.path})"
        export OPENAI_API_KEY
        exec ${lib.escapeShellArg "${scrivener}/bin/git-scrivener"} "$@"
      '';
    };
  };
}
```

The store contains the script and the secret's pathname, not its contents. Do not use `builtins.readFile` on the decrypted key or put API-key values in `home.sessionVariables`. Remove any previous direct `home.packages` installation of `git-scrivener` or its wrapper to avoid competing executables; the module now handles installation. The example loads only the OpenAI key; Anthropic needs `ANTHROPIC_API_KEY` supplied separately.

## Validation

`checks.<system>.home-manager` evaluates the exported module with real Home Manager and executes its generated wrappers against an isolated argument recorder. It covers disabled/default configurations, package selection, invalid settings, Anthropic with and without a model override, CLI overrides, shell quoting, runtime key inheritance, and exit status propagation. It neither contacts APIs nor changes an installed Home Manager generation.

```sh
nix build --no-link --no-write-lock-file --print-build-logs ".#checks.$(nix eval --impure --raw --expr builtins.currentSystem).home-manager"
```

The `home-manager` flake input is used for these checks. Consumers use the Home Manager instance in their own configuration when importing the exported module.

References: [Home Manager flake integration](https://nix-community.github.io/home-manager/index.xhtml#ch-nix-flakes), [Home Manager program module example](https://github.com/nix-community/home-manager/blob/master/modules/programs/gh.nix), [Home Manager configuration evaluator](https://github.com/nix-community/home-manager/blob/master/lib/eval-config.nix).

The Anthropic default uses the [official Haiku 5.5 model ID](https://platform.claude.com/docs/en/models/haiku-5-5/overview).
