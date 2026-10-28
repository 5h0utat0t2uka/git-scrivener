{
  description = "A flake for a Node.js development environment with pnpm and TypeScript support.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    git-hooks.url = "github:cachix/git-hooks.nix";
  };

  outputs = { nixpkgs, flake-utils, git-hooks, ... }: flake-utils.lib.eachDefaultSystem (system:
    let
      pkgs = import nixpkgs { inherit system; };
      fixedNode = import ./nix/fixed-node.nix { inherit pkgs system; };
      preCommit = import ./nix/pre-commit.nix { inherit pkgs git-hooks system fixedNode; src = ./.; };
    in
    {
      formatter = pkgs.nixfmt;
      checks = {
        pre-commit = preCommit;
      };
      devShells.default = pkgs.mkShell {
        packages = [
          fixedNode.nodejs
          fixedNode.pnpm
          pkgs.age
          pkgs.betterleaks
          pkgs.prek
          pkgs.semgrep
          pkgs.sops
          pkgs.typescript-language-server
          pkgs.zizmor
        ] ++ preCommit.enabledPackages;
        shellHook = ''
          ${preCommit.shellHook}
          echo "node: $(node -v)"
          echo "pnpm: $(pnpm -v)"
        '';
      };
    }
  );
}
