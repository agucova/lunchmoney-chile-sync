{
  description = "Syncs Chilean bank accounts and credit cards into Lunch Money";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Production node_modules as a fixed-output derivation. All runtime deps are
      # pure JS (the scraper is a vendored prebuilt tarball), so the tree — and its
      # hash — is platform-independent. Dep changes: rebuild fails on hash mismatch,
      # copy the new hash from the error.
      nodeModulesFor = pkgs: pkgs.stdenvNoCC.mkDerivation {
        pname = "lunchmoney-chile-sync-node-modules";
        version = "0";
        src = nixpkgs.lib.fileset.toSource {
          root = ./.;
          fileset = nixpkgs.lib.fileset.unions [ ./package.json ./bun.lock ./vendor ];
        };
        nativeBuildInputs = [ pkgs.bun ];
        dontConfigure = true;
        dontFixup = true; # fixup patches shebangs with store paths — fatal in a FOD
        buildPhase = ''
          export HOME=$TMPDIR
          bun install --frozen-lockfile --production --no-progress
        '';
        installPhase = ''
          mkdir -p $out
          cp -r node_modules $out/node_modules
        '';
        outputHashAlgo = "sha256";
        outputHashMode = "recursive";
        outputHash = "sha256-afYr111dzPFXl/tZfRjR7Y1f9wj1saQYUJkXa813OfQ=";
      };

      packageFor = pkgs:
        let nodeModules = nodeModulesFor pkgs;
        in pkgs.stdenvNoCC.mkDerivation {
          pname = "lunchmoney-chile-sync";
          version = "0.1.0";
          src = nixpkgs.lib.fileset.toSource {
            root = ./.;
            fileset = nixpkgs.lib.fileset.unions [
              ./package.json
              ./bun.lock
              ./src
              ./drizzle
              ./vendor
            ];
          };
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
            mkdir -p $out/share/lunchmoney-chile-sync $out/bin
            cp -r src drizzle vendor package.json bun.lock $out/share/lunchmoney-chile-sync/
            ln -s ${nodeModules}/node_modules $out/share/lunchmoney-chile-sync/node_modules
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/lunchmoney-chile-sync \
              --add-flags "run $out/share/lunchmoney-chile-sync/src/main.ts"
          '';
          meta.mainProgram = "lunchmoney-chile-sync";
        };
    in
    {
      packages = forAllSystems (pkgs: rec {
        node_modules = nodeModulesFor pkgs;
        lunchmoney-chile-sync = packageFor pkgs;
        default = lunchmoney-chile-sync;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.bun pkgs.nodejs pkgs.sqlite ]; };
      });

      nixosModules.default = import ./nix/module.nix self;
    };
}
