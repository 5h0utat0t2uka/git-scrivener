{
  description = "git-scrivener: generate Conventional Commit messages from staged changes.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Evaluate the exported module against Home Manager in the flake checks.
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    agent-skills = {
      url = "github:Kyure-A/agent-skills-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      git-hooks,
      home-manager,
      agent-skills,
      ...
    }:
    {
      homeManagerModules = rec {
        git-scrivener = import ./nix/home-manager.nix { inherit self; };
        default = git-scrivener;
      };
    }
    // flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [
            (final: prev: {
              # Semgrep 1.180.0 requires the MCP v1 API (FastMCP).
              # https://github.com/semgrep/semgrep/blob/v1.180.0/cli/pyproject.toml
              semgrep =
                if prev.semgrep.version == "1.180.0" then
                  prev.semgrep.override {
                    mcp = final.python3Packages.mcp_1;
                  }
                else
                  prev.semgrep;
            })
          ];
        };
        nodejs = pkgs.nodejs_26;
        # fetchPnpmDeps uses pnpm's nodejs-slim when installing the locked dependencies.
        pnpm = pkgs.pnpm_12.override { nodejs-slim = pkgs.nodejs-slim_26; };
        scrivener = import ./nix/package.nix { inherit pkgs nodejs pnpm; };
        preCommit = import ./nix/pre-commit.nix {
          inherit
            pkgs
            git-hooks
            system
            nodejs
            pnpm
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
          home-manager = import ./nix/tests/home-manager.nix {
            inherit pkgs home-manager nodejs;
            module = self.homeManagerModules.default;
            package = scrivener;
          };
        };
        packages = {
          default = scrivener;
          git-scrivener = scrivener;
        };
        apps = rec {
          default = git-scrivener;
          git-scrivener = {
            type = "app";
            program = "${scrivener}/bin/git-scrivener";
          };
          skills-install-local = {
            type = "app";
            program = "${skillsInstall}/bin/skills-install-local";
          };
        };
        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            pnpm
            pkgs.git
            pkgs.typescript-language-server
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
