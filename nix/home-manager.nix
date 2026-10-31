{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.git-scrivener;
  defaultArgs = [
    "--provider"
    cfg.provider
    "--language"
    cfg.language
  ]
  ++ lib.optionals (cfg.model != null) [
    "--model"
    cfg.model
  ];
in
{
  options.programs.git-scrivener = {
    enable = lib.mkEnableOption "git-scrivener commit message generation";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.git-scrivener;
      defaultText = lib.literalExpression "inputs.git-scrivener.packages.\${pkgs.stdenv.hostPlatform.system}.git-scrivener";
      description = ''
        Package providing bin/git-scrivener. The default uses this flake's
        pinned package. A custom package may supply runtime credentials.
      '';
    };

    provider = lib.mkOption {
      type = lib.types.enum [
        "openai"
        "anthropic"
      ];
      default = "openai";
      description = "Default API provider. May be overridden with --provider.";
    };

    language = lib.mkOption {
      type = lib.types.enum [
        "en"
        "ja"
      ];
      default = "en";
      description = "Default commit message language. May be overridden with --language.";
    };

    model = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.addCheck lib.types.str (
          value: builtins.match "[^[:space:]](.*[^[:space:]])?" value != null
        )
      );
      default = null;
      example = "gpt-6-luna";
      description = ''
        Default model identifier, without surrounding whitespace. Null uses
        the CLI's default model for the selected provider.
        May be overridden with --model.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [
      (pkgs.writeShellApplication {
        name = "git-scrivener";
        text = ''
          # Nix-escaped settings are literal arguments, never shell expressions.
          # shellcheck disable=SC2016
          exec ${lib.escapeShellArg (lib.getExe' cfg.package "git-scrivener")} ${lib.escapeShellArgs defaultArgs} "$@"
        '';
      })
    ];
  };
}
