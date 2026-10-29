{ pkgs }:

let
  # flake.lock pins the Node.js 24 package and its Nix build integration.
  nodejs = pkgs.nodejs_24;

  # Keep package.json's packageManager version while retaining the standard
  # pnpm package metadata used by fetchPnpmDeps.
  pnpm = pkgs.pnpm_10.override {
    nodejs-slim = nodejs;
    version = "10.34.9";
    hash = "sha256-foqUYQjnuqsRnlHSfCTWF4tGVFQiZD28keNOLx7jLg8=";
  };
in
{
  inherit nodejs pnpm;
}
