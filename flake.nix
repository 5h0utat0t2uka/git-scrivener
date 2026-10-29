{
  description = "git-scrivener: generate Conventional Commit messages from staged changes.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    git-hooks.url = "github:cachix/git-hooks.nix";
    agent-skills = {
      url = "github:Kyure-A/agent-skills-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      git-hooks,
      agent-skills,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [
            (final: prev: {
              # Semgrep 1.180.0 requires the MCP v1 API (FastMCP).
              # https://github.com/semgrep/semgrep/blob/v1.180.0/cli/pyproject.toml
              semgrep = prev.semgrep.override {
                mcp = final.python3Packages.mcp_1;
              };
            })
          ];
        };
        fixedNode = import ./nix/fixed-node.nix { inherit pkgs; };
        scrivener = import ./nix/package.nix { inherit pkgs fixedNode; };
        preCommit = import ./nix/pre-commit.nix {
          inherit
            pkgs
            git-hooks
            system
            fixedNode
            ;
          src = ./.;
        };
        agentLib = agent-skills.lib.agent-skills;
        skillsInstall = agentLib.mkLocalInstallProgram {
          inherit pkgs;
          bundle = agentLib.mkBundle {
            inherit pkgs;
            # No skills are selected until their sources have been reviewed.
            selection = { };
          };
          targets.agents = {
            enable = true;
            dest = ".agents/skills";
            structure = "copy-tree";
          };
        };
      in
      {
        formatter = pkgs.nixfmt-tree;
        checks = {
          pre-commit = preCommit;
          package = scrivener;
        };
        packages = {
          default = scrivener;
          git-scrivener = scrivener;
        };
        apps.default = {
          type = "app";
          program = "${scrivener}/bin/git-scrivener";
        };
        apps.git-scrivener = {
          type = "app";
          program = "${scrivener}/bin/git-scrivener";
        };
        apps.skills-install-local = {
          type = "app";
          program = "${skillsInstall}/bin/skills-install-local";
        };
        devShells.default = pkgs.mkShell {
          packages = [
            fixedNode.nodejs
            fixedNode.pnpm
            pkgs.git
            pkgs.age
            pkgs.betterleaks
            pkgs.prek
            pkgs.semgrep
            pkgs.sops
            pkgs.typescript-language-server
            pkgs.zizmor
          ]
          ++ preCommit.enabledPackages;
          shellHook = ''
            ${preCommit.shellHook}
            echo "node: $(node -v)"
            echo "pnpm: $(pnpm -v)"
          '';
        };
      }
    );
}
