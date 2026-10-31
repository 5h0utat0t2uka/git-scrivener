{
  pkgs,
  home-manager,
  module,
  package,
}:

let
  inherit (pkgs) lib;
  recorderScript = pkgs.writeText "scrivener-arguments.mjs" ''
    import { parseArgs } from 'node:util';
    const { values } = parseArgs({
      options: {
        provider: { type: 'string' },
        language: { type: 'string' },
        model: { type: 'string' },
        'exit-code': { type: 'string', default: '0' },
      },
    });
    console.log(JSON.stringify({
      ...values,
      openaiKey: process.env.OPENAI_API_KEY === 'test-openai-key',
      anthropicKey: process.env.ANTHROPIC_API_KEY === 'test-anthropic-key',
    }));
    process.exitCode = Number(values['exit-code']);
  '';
  recorder = pkgs.writeShellApplication {
    name = "git-scrivener";
    text = ''
      exec ${pkgs.nodejs}/bin/node ${recorderScript} "$@"
    '';
  };
  evaluate =
    settings:
    home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      modules = [
        module
        {
          home.username = "scrivener-test";
          home.homeDirectory =
            if pkgs.stdenv.hostPlatform.isDarwin then "/Users/scrivener-test" else "/home/scrivener-test";
          home.stateVersion = "25.11";
          programs.git-scrivener = settings;
        }
      ];
    };
  enabled =
    settings:
    evaluate (
      {
        enable = true;
        package = recorder;
      }
      // settings
    );
  valid = result: lib.all (entry: entry.assertion) result.config.assertions;
  installed =
    result: lib.filter (entry: lib.getName entry == "git-scrivener") result.config.home.packages;
  executable = result: lib.getExe' (lib.head (installed result)) "git-scrivener";

  disabled = evaluate { };
  defaults = enabled { };
  japanese = enabled {
    language = "ja";
    model = "test-model'$(touch unexpected)";
  };
  anthropic = enabled {
    provider = "anthropic";
    model = "claude-test-model";
  };
  anthropicDefault = enabled { provider = "anthropic"; };
  invalidProvider =
    builtins.tryEval
      (evaluate { provider = "other"; }).config.programs.git-scrivener.provider;
  invalidLanguage =
    builtins.tryEval
      (evaluate { language = "fr"; }).config.programs.git-scrivener.language;
  invalidModels =
    map (model: builtins.tryEval (evaluate { inherit model; }).config.programs.git-scrivener.model)
      [
        ""
        " "
        " model"
        "model "
      ];
in
assert disabled.config.programs.git-scrivener.package.outPath == package.outPath;
assert installed disabled == [ ];
assert valid (evaluate {
  provider = "anthropic";
});
assert valid defaults && valid japanese && valid anthropic && valid anthropicDefault;
assert !invalidProvider.success && !invalidLanguage.success;
assert lib.all (result: !result.success) invalidModels;
assert lib.all (result: lib.length (installed result) == 1) [
  defaults
  japanese
  anthropic
  anthropicDefault
];
pkgs.runCommand "git-scrivener-home-manager-test" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
  ${executable defaults} > defaults.json
  ${executable japanese} > japanese.json
  ${executable anthropic} > anthropic.json
  ${executable anthropicDefault} > anthropic-default.json
  OPENAI_API_KEY=test-openai-key ANTHROPIC_API_KEY=test-anthropic-key \
    ${executable japanese} --provider anthropic --language en --model override-model > overridden.json

  scrivener_test_status=0
  ${executable defaults} --exit-code 23 > /dev/null || scrivener_test_status=$?
  test "$scrivener_test_status" = 23
  test ! -e unexpected

  node --input-type=module <<'JS'
  import assert from 'node:assert/strict';
  import { readFileSync } from 'node:fs';
  const read = (name) => JSON.parse(readFileSync(name + '.json', 'utf8'));
  assert.deepEqual(read('defaults'), {
    provider: 'openai', language: 'en', 'exit-code': '0',
    openaiKey: false, anthropicKey: false,
  });
  assert.deepEqual(read('japanese'), {
    provider: 'openai', language: 'ja', model: "test-model'$(touch unexpected)",
    'exit-code': '0', openaiKey: false, anthropicKey: false,
  });
  assert.deepEqual(read('anthropic'), {
    provider: 'anthropic', language: 'en', model: 'claude-test-model',
    'exit-code': '0', openaiKey: false, anthropicKey: false,
  });
  assert.deepEqual(read('anthropic-default'), {
    provider: 'anthropic', language: 'en', 'exit-code': '0',
    openaiKey: false, anthropicKey: false,
  });
  assert.deepEqual(read('overridden'), {
    provider: 'anthropic', language: 'en', model: 'override-model',
    'exit-code': '0', openaiKey: true, anthropicKey: true,
  });
  JS
  touch "$out"
''
