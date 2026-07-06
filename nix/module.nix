# NixOS module: daily sync as a hardened oneshot systemd service + timer.
#
# Secrets (bank credentials + LM token) come from an EnvironmentFile (agenix/sops
# secret on the host) with the same names as .env.example. The scraper needs a real
# Chromium; the schedule defaults to late morning America/Santiago — Santander's
# portal blocks logins in the overnight window (docs/phase0-findings.md).
self: { config, lib, pkgs, ... }:
let
  cfg = config.services.lunchmoney-chile-sync;
  settingsFormat = pkgs.formats.toml { };
  configFile = settingsFormat.generate "lunchmoney-chile-sync-config.toml" cfg.settings;
in
{
  options.services.lunchmoney-chile-sync = {
    enable = lib.mkEnableOption "Lunch Money Chile sync";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "The sync package to run.";
    };

    settings = lib.mkOption {
      inherit (settingsFormat) type;
      description = ''
        Contents of config.toml (connections, accounts, LM account ids). Secrets stay
        in environmentFile; this only holds env-var *references*.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        EnvironmentFile with SANTANDER_RUT/SANTANDER_PASS, BANCOCHILE_RUT/
        BANCOCHILE_PASS, LUNCHMONEY_TOKEN (e.g. an agenix secret path).
      '';
    };

    schedule = lib.mkOption {
      type = lib.types.str;
      default = "*-*-* 10:30:00 America/Santiago";
      description = "systemd OnCalendar expression. Keep it in Chilean daytime.";
    };

    chromiumPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.chromium;
      description = "Browser used by the scraper.";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Extra packages on PATH (e.g. the package providing ai-notify).";
    };
  };

  config = lib.mkIf cfg.enable {
    # The state db lives in StateDirectory; settings.state.db_path must agree.
    services.lunchmoney-chile-sync.settings.state.db_path =
      lib.mkDefault "/var/lib/lunchmoney-chile-sync/state.sqlite";

    systemd.services.lunchmoney-chile-sync = {
      description = "Lunch Money Chile sync";
      path = cfg.extraPackages;
      environment = {
        OBC_CHROME_PATH = lib.getExe cfg.chromiumPackage;
        SYNC_DRIFT_DIR = "/var/lib/lunchmoney-chile-sync/drift";
        XDG_CACHE_HOME = "/var/lib/lunchmoney-chile-sync/.cache";
      };
      serviceConfig = {
        Type = "oneshot";
        ExecStartPre = "${pkgs.coreutils}/bin/mkdir -p /var/lib/lunchmoney-chile-sync/drift";
        ExecStart = "${lib.getExe cfg.package} sync --config ${configFile}";
        EnvironmentFile = cfg.environmentFile;
        DynamicUser = true;
        StateDirectory = "lunchmoney-chile-sync";
        WorkingDirectory = "/var/lib/lunchmoney-chile-sync";
        TimeoutStartSec = "30min";
        # Hardening (Chromium needs user namespaces + /dev/shm).
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        NoNewPrivileges = true;
      };
    };

    systemd.timers.lunchmoney-chile-sync = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.schedule;
        RandomizedDelaySec = "30min";
        Persistent = true;
      };
    };
  };
}
