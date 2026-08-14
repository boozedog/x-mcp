{ config, lib, pkgs, ... }:
let
  cfg = config.services.x-mcp;
in
{
  options.services.x-mcp = {
    enable = lib.mkEnableOption "x-mcp MCP server for the X API";

    package = lib.mkOption {
      type = lib.types.package;
      default = null;
      description = "The x-mcp package to run.";
    };

    stateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/x-mcp";
      description = "Directory for auth.json and cache.sqlite (0700).";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8788;
      description = "Port for the MCP HTTP server.";
    };

    clientId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Public X OAuth2 client id (not a secret).";
    };

    pollInterval = lib.mkOption {
      type = lib.types.int;
      default = 180;
      description = "Bookmark poller interval in seconds.";
    };

    extraArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "Extra CLI arguments passed to `x-mcp serve`.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.x-mcp = {
      description = "x-mcp MCP server for the X API";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      serviceConfig = {
        Type = "simple";
        ExecStart = lib.concatStringsSep " " ([
          "${cfg.package}/bin/x-mcp"
          "serve"
          "--state-dir"
          cfg.stateDir
          "--port"
          (toString cfg.port)
          "--poll-interval"
          (toString cfg.pollInterval)
        ] ++ lib.optionals (cfg.clientId != "") [
          "--client-id"
          cfg.clientId
        ] ++ cfg.extraArgs);
        Environment = [ "X_MCP_STATE_DIR=${cfg.stateDir}" ];
        Restart = "on-failure";
        RestartSec = "5s";
        StateDirectory = "x-mcp";
        StateDirectoryMode = "0700";
        # systemd-managed writable Deno cache. systemd creates /var/cache/x-mcp
        # (owned by the DynamicUser), makes it writable even under
        # ProtectSystem=strict, and exports \$CACHE_DIRECTORY for the wrapper.
        CacheDirectory = "x-mcp";
        CacheDirectoryMode = "0700";
        # Named dynamic user: the service and any transient login unit that also
        # requests User=x-mcp + DynamicUser=yes share the same dynamic UID (systemd
        # keys dynamic users by name). This does NOT weaken DynamicUser.
        User = "x-mcp";
        DynamicUser = true;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
        LockPersonality = true;
        # NOTE: MemoryDenyWriteExecute is intentionally NOT set — Deno 2.9.4's
        # V8 runtime panics under MDWE (Fatal error: Check failed: 12 == errno).
      };
    };
  };
}
