# lunchmoney-chile-sync

Near-fully-automated personal finance: syncs Chilean bank accounts and credit cards into
[Lunch Money](https://lunchmoney.app). Successor to a 2024 Rust prototype that stalled when
no aggregator API could deliver Chilean credit-card data (Fintoc never shipped it, SaltEdge
left Chile, and open finance under Ley Fintech won't reach personas before ~2028).

## How it works

```
sources (adapters)             core (pure where possible)               sink
┌─────────────────┐   ┌───────────────────────────────────────┐   ┌─────────────┐
│ obc (scraper)   │ → │ ingest → identity ledger → reconcile   │ → │ Lunch Money │
│ khipu/floid/…   │   │        → SyncPlan (explicit diff)      │   │ (v2 + v1)   │
│ [investments]   │   │ SQLite: identities, runs, ops journal  │   │             │
└─────────────────┘   └───────────────────────────────────────┘   └─────────────┘
```

- **Sources** are pluggable adapters fetching per _connection_ (one bank login → checking +
  credit cards in one pass). Each account lists ordered `sources` in `config.toml`: the first
  is primary, the rest are fallbacks. The initial source wraps
  [open-banking-chile](https://github.com/kaihv/open-banking-chile), vendored as a prebuilt
  tarball pinned by commit (`vendor/`, regenerated via `scripts/update-obc.sh`) and run as an
  isolated bun subprocess speaking JSON-lines (`src/obc-runner.ts`).
- **Core** assigns every transaction a source-agnostic, DB-authoritative identity, reconciles
  credit-card lifecycle (unbilled → billed, cuotas, USD → CLP settlement), and emits an
  explicit `SyncPlan` — so `--dry-run` shows exactly what would change.
- **Sink** applies the plan idempotently against the Lunch Money API (v2 inserts deduped by
  `external_id`; balances via v1).

Money is represented as BigInt minor units with same-currency-only arithmetic (CLP has no
decimals); floats never touch amounts.

## Status

Phase 1: checking accounts (Santander + Banco de Chile) sync end-to-end, idempotently
(`bun run sync` / `bun src/main.ts sync [--dry-run] [account…]`, `status`). Credit-card
lifecycle is Phase 2; NixOS deployment pending.

## Development

```sh
bun install   # everything, including the vendored scraper tarball
bun run check # typecheck + lint + fmt + tests
```

Bumping the scraper pin is the one dev-time task that needs node/npm:
`scripts/update-obc.sh <commit>` rebuilds the vendored tarball.

Credentials go in `.env` (see `.env.example`) — never in config or code.

## Deployment (NixOS)

The flake exports `packages.default` (bun app wrapped from the store; production
node_modules built as a fixed-output derivation — on dependency changes the build fails
with the new hash to paste into `flake.nix`) and `nixosModules.default`:

```nix
# in the host flake
inputs.lunchmoney-chile-sync.url = "github:agucova/lunchmoney-chile-sync"; # or a path

# in the host config
imports = [ inputs.lunchmoney-chile-sync.nixosModules.default ];
services.lunchmoney-chile-sync = {
  enable = true;
  environmentFile = config.age.secrets.lunchmoney-sync-env.path; # .env.example names
  settings = { /* config.toml contents — see this repo's config.toml */ };
  # schedule defaults to 10:30 America/Santiago (+ ≤30min jitter): Santander's portal
  # rejects overnight logins, and daytime is when a 2FA push can actually be approved.
};
```

The service runs as a hardened oneshot (DynamicUser, StateDirectory for the SQLite
ledger and drift payloads) with nixpkgs Chromium via `OBC_CHROME_PATH`. Add the package
providing `ai-notify` to `extraPackages` for failure/2FA push notifications.

## License

[MPL-2.0](LICENSE)
