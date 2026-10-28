/**
  to get the hash of nodejs, run the following command in your terminal:

  for slug in darwin-arm64 darwin-x64 linux-arm64:tar.xz linux-x64:tar.xz; do
    v=24.22.1; p="${slug%%:*}"; ext="${slug#*:}"; [ "$ext" = "$p" ] && ext=tar.gz
    nix store prefetch-file --json \
      "https://nodejs.org/dist/v${v}/node-v${v}-${p}.${ext}" | jq -r '.hash'
  done
*/

{ pkgs, system }:

let
  inherit (pkgs.stdenv.hostPlatform) isDarwin isLinux isAarch64 isx86_64;

  nodeVersion = "24.22.1";
  pnpmVersion = "10.34.9";

  nodePlatform =
    if isDarwin && isAarch64 then {
      slug = "darwin-arm64";
      ext = "tar.gz";
      hash = "sha256-icaCWT12zUQjP6U7FWMmTn3py7GJytFpE1xbT637wKc=";
    } else if isDarwin && isx86_64 then {
      slug = "darwin-x64";
      ext = "tar.gz";
      hash = "sha256-0TJVfn7iuFrwiwyMNDOOZcZDDyI40B9ydyjvQtyDsDU=";
    } else if isLinux && isAarch64 then {
      slug = "linux-arm64";
      ext = "tar.xz";
      hash = "sha256-26v3ocv5R+YFn/rSwnuABB25feoeVTtir97n8T/KM24=";
    } else if isLinux && isx86_64 then {
      slug = "linux-x64";
      ext = "tar.xz";
      hash = "sha256-bBcqmrZxj3uAH7WnvUhq8u5eMnWAhqBLhPzOKqdwleY=";
    } else
      throw "Unsupported system: ${system}";

  nodejs = pkgs.stdenvNoCC.mkDerivation {
    pname = "nodejs";
    version = nodeVersion;
    src = pkgs.fetchurl {
      url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-${nodePlatform.slug}.${nodePlatform.ext}";
      inherit (nodePlatform) hash;
    };
    nativeBuildInputs = [
      pkgs.gnutar
    ] ++ pkgs.lib.optionals isLinux [
      pkgs.autoPatchelfHook
    ];
    buildInputs = pkgs.lib.optionals isLinux [
      pkgs.stdenv.cc.cc.lib
    ];
    dontUnpack = true;
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      tar -xf "$src" --strip-components=1 -C "$out"
      runHook postInstall
    '';
  };

  pnpm = pkgs.stdenvNoCC.mkDerivation {
    pname = "pnpm";
    version = pnpmVersion;
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/pnpm/-/pnpm-${pnpmVersion}.tgz";
      hash = "sha256-foqUYQjnuqsRnlHSfCTWF4tGVFQiZD28keNOLx7jLg8=";
    };
    nativeBuildInputs = [
      pkgs.gnutar
      pkgs.gzip
      pkgs.makeWrapper
    ];
    dontUnpack = true;
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/libexec" "$out/bin"
      tar -xzf "$src" --strip-components=1 -C "$out/libexec"
      makeWrapper "${nodejs}/bin/node" "$out/bin/pnpm" \
        --add-flags "$out/libexec/bin/pnpm.cjs" \
        --prefix PATH : "${nodejs}/bin" \
        --set npm_config_manage_package_manager_versions false
      runHook postInstall
    '';
  };
in
{
  inherit nodejs pnpm;
}
