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
          denoCache = pkgs.stdenv.mkDerivation {
            pname = "x-mcp-deno-cache";
            version = "1.0.0";
            src = ./.;
            nativeBuildInputs = [ deno ];
            buildPhase = ''
              export DENO_DIR=$out
              deno cache --lock=deno.lock src/main.ts
            '';
            installPhase = "true";
            outputHash = "sha256-nIib/EDGFron4MOGErkVKfvBQRXwnDBRflt0PYiIYW4=";
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
              export DENO_DIR=$out/lib/deno-cache
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

      # Wrap the self-contained module so `package` defaults to this flake's
      # package without the module needing `self` as a formal arg.
      nixosModules.default = { config, lib, pkgs, ... }:
        let
          base = import ./nixos-module.nix;
        in
        {
          imports = [ base ];
          services.x-mcp.package = lib.mkDefault self.packages.${pkgs.system}.x-mcp;
        };
    };
}
