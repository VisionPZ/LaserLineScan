{
  description = "LaserLineScan - an open, browser-only laser line scan lab";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      version = "1.0.0";
      meta = {
        description = "Browser-only structured-light laser line scanner";
        homepage = "https://github.com/VisionPZ/LaserLineScan";
        license = nixpkgs.lib.licenses.gpl3Plus;
        platforms = systems;
      };
    in
    {
      # `nix develop` gives the whole environment the project needs: the runtime
      # is plain ES modules, the kernel builds with AssemblyScript through npm,
      # the tests run on node, and the browser probe drives Chromium from python.
      devShells = eachSystem (system: {
        default =
          let
            pkgs = nixpkgs.legacyPackages.${system};
            python = pkgs.python3.withPackages (ps: [ ps.playwright ]);
          in
          pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              python
              pkgs.git
              pkgs.git-lfs
              pkgs.chromium
              pkgs.nixfmt-rfc-style
            ];
            shellHook = ''
              export NIDVUE_CHROMIUM=${pkgs.chromium}/bin/chromium
              echo "laser-line-scan: node $(node --version), python $(python3 --version | cut -d' ' -f2), chromium from the nix store"
              echo "  npm test                              unit and integration tests (no browser)"
              echo "  node serve.mjs                        open http://localhost:8080"
              echo "  python tests/smoke.py                 browser walkthrough, uses NIDVUE_CHROMIUM"
              echo "  npm install && npm run build:kernel   rebuild runtime/core.wasm"
            '';
          };
      });

      # `nix build` gives the published site as a store path: the page, the
      # runtime, the demo capture set and the docs, ready for any static server.
      packages = eachSystem (system: {
        default = nixpkgs.legacyPackages.${system}.stdenvNoCC.mkDerivation {
          pname = "laser-line-scan";
          inherit version meta;
          src = builtins.path { path = ./.; name = "laser-line-scan-source"; };
          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/laser-line-scan
            cp -r index.html serve.mjs runtime demo docs kernel tools package.json \
                  README.md LICENSE NOTICE $out/share/laser-line-scan/
            runHook postInstall
          '';
        };
      });

      # The offline suites are run by `nix develop --command npm test` (and by
      # CI); `nix flake check` therefore validates evaluation rather than
      # re-running node inside a derivation.
      apps = eachSystem (system: {
        serve = {
          type = "app";
          program = "${nixpkgs.legacyPackages.${system}.writeShellScriptBin "laser-line-scan-serve" ''
            exec ${nixpkgs.legacyPackages.${system}.nodejs_22}/bin/node ${self}/serve.mjs "$@"
          ''}/bin/laser-line-scan-serve";
          meta = { inherit (meta) description; };
        };
      });

      formatter = eachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style);
    };
}
