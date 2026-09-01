{
  description = "x-mcp: personal Deno MCP server for the X API (cache + bookmarks)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          deno = pkgs.deno;
          src = ./.;

          # Fixed-output derivation: populate the Deno module cache from deno.lock.
          # This is the only step that needs network access.
          #
          # Keep only lockfile-defined module trees (npm/, deps/). Deno also
          # writes gen/ and analysis sqlite DBs that change with the toolchain;
          # hashing those breaks this FOD when a consumer follows a different
          # nixpkgs (issue #7). Runtime already copies DENO_DIR to a writable
          # cache and regenerates those files.
          denoCache = pkgs.stdenv.mkDerivation {
            pname = "x-mcp-deno-cache";
            version = "1.0.0";
            src = ./.;
            nativeBuildInputs = [ deno ];
            buildPhase = ''
              export DENO_DIR=$(mktemp -d)
              deno cache --lock=deno.lock src/main.ts
              mkdir -p $out
              for tree in npm deps; do
                if [ -d "$DENO_DIR/$tree" ]; then
                  cp -a "$DENO_DIR/$tree" "$out/"
                fi
              done
              test -d "$out/npm"
            '';
            installPhase = "true";
            outputHash = "sha256-C57QQqTdYnfd24pS9/9iYqqYUDFEOAgj2eUTGwYhrbk=";
            outputHashAlgo = "sha256";
            outputHashMode = "recursive";
          };

          # Ship `deno run --cached-only` from a store path (issue #1 allows this
          # instead of `deno compile`). The wrapper points DENO_DIR at the
          # pre-populated cache and runs the source with the needed permissions.
          x-mcp = pkgs.stdenv.mkDerivation {
            pname = "x-mcp";
            version = "1.0.0";
            inherit src;
            nativeBuildInputs = [ deno ];
            installPhase = ''
              mkdir -p $out/bin $out/lib
              cp -r ${denoCache} $out/lib/deno-cache
              cp -r src $out/lib/src
              cp deno.json deno.lock $out/lib/
              cat > $out/bin/x-mcp <<EOF
              #!${pkgs.stdenv.shell}
              # DENO_DIR must be writable (Deno writes a V8 code cache there).
              # Prefer a systemd-managed writable cache directory when the unit
              # declares CacheDirectory= (systemd sets \$CACHE_DIRECTORY). This is
              # the reliable path under DynamicUser + ProtectSystem=strict.
              # Otherwise fall back to a per-user cache dir for local/package use.
              CACHE_DIR=""
              if [ -n "\$CACHE_DIRECTORY" ]; then
                CACHE_DIR="\$CACHE_DIRECTORY"
              fi
              if [ -z "\$CACHE_DIR" ]; then
                CACHE_DIR="\$HOME/.cache/x-mcp"
                if [ -n "\$XDG_CACHE_HOME" ]; then
                  CACHE_DIR="\$XDG_CACHE_HOME/x-mcp"
                fi
              fi
              mkdir -p "\$CACHE_DIR"
              if [ ! -e "\$CACHE_DIR/.seeded" ]; then
                cp -r $out/lib/deno-cache/. "\$CACHE_DIR/" 2>/dev/null || true
                touch "\$CACHE_DIR/.seeded"
              fi
              export DENO_DIR="\$CACHE_DIR"
              exec ${deno}/bin/deno run --cached-only \
                --allow-env --allow-read --allow-write --allow-net \
                $out/lib/src/main.ts "\$@"
              EOF
              chmod +x $out/bin/x-mcp
            '';
          };
        in
        {
          x-mcp = x-mcp;
          default = x-mcp;
        });

      apps = forAllSystems (system:
        let
          pkg = self.packages.${system}.x-mcp;
        in
        {
          x-mcp = {
            type = "app";
            program = "${pkg}/bin/x-mcp";
          };
          default = self.apps.${system}.x-mcp;
        });

      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [ pkgs.deno pkgs.sqlite ];
          };
        });

      # Reproducible module evaluation: assert the hardened service declares a
      # systemd-managed writable cache and that the packaged wrapper prefers
      # $CACHE_DIRECTORY. Fails at evaluation time if any assertion is false.
      checks = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          pkg = self.packages.${system}.x-mcp;
          nixos = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.default
              {
                services.x-mcp.enable = true;
                services.x-mcp.clientId = "test-client";
              }
            ];
          };
          # Non-loopback host: the Docker-hosted LiteLLM use case (issue #5).
          nixosNonLoopback = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.default
              {
                services.x-mcp.enable = true;
                services.x-mcp.clientId = "test-client";
                services.x-mcp.host = "0.0.0.0";
              }
            ];
          };
          svc = nixos.config.systemd.services.x-mcp;
          svcNonLoopback = nixosNonLoopback.config.systemd.services.x-mcp;
          assertions = [
            (assert svc.serviceConfig.CacheDirectory == "x-mcp";
              "CacheDirectory=x-mcp declared")
            (assert svc.serviceConfig.CacheDirectoryMode == "0700";
              "CacheDirectoryMode=0700 declared")
            (assert svc.serviceConfig.DynamicUser == true;
              "DynamicUser preserved")
            (assert svc.serviceConfig.ProtectSystem == "strict";
              "ProtectSystem=strict preserved")
            (assert svc.serviceConfig.ProtectHome == true;
              "ProtectHome preserved")
            (assert svc.serviceConfig.StateDirectory == "x-mcp";
              "StateDirectory=x-mcp preserved")
            (assert svc.serviceConfig.StateDirectoryMode == "0700";
              "StateDirectoryMode=0700 preserved")
            (assert svc.serviceConfig.User == "x-mcp";
              "named dynamic user x-mcp")
            (assert (builtins.match ".*--host 127\\.0\\.0\\.1.*" svc.serviceConfig.ExecStart) != null;
              "ExecStart passes --host 127.0.0.1 by default")
            (assert (builtins.match ".*--host 0\\.0\\.0\\.0.*" svcNonLoopback.serviceConfig.ExecStart) != null;
              "ExecStart passes --host 0.0.0.0 when configured")
          ];
        in
        {
          module-eval = pkgs.runCommand "x-mcp-module-eval" { } ''
            echo "module assertions passed: ${builtins.concatStringsSep ", " assertions}"
            # The packaged wrapper must assign CACHE_DIR from the systemd-provided
            # cache dir (match the assignment, not the explanatory comment).
            grep -q 'CACHE_DIR="\$CACHE_DIRECTORY"' ${pkg}/bin/x-mcp
            echo "wrapper assigns CACHE_DIR from \$CACHE_DIRECTORY"
            touch $out
          '';
        });

      # Wrap the self-contained module so `package` defaults to this flake's
      # package without the module needing `self` as a formal arg.
      nixosModules.default = { config, lib, pkgs, ... }:
        let
          base = import ./nixos-module.nix;
        in
        {
          imports = [ base ];
          services.x-mcp.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.x-mcp;
        };
    };
}
