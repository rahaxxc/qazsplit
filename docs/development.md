# Development and verification

## Frontend quick start

Use Node.js 24.x and npm 11.x. Commands run at repository root; npm workspaces route frontend commands into `app/`.

```bash
git clone https://github.com/rahaxxc/qazsplit.git
cd qazsplit
npm ci
npm run dev
```

Open `http://localhost:3000`. This frontend reads the existing **devnet** deployment, not a newly deployed local program. Browsing needs no keys or environment file. Signing requires a wallet extension such as Phantom or Solflare, set to Solana Devnet.

```bash
npm run lint
npm test
npm exec --workspace app -- tsc --noEmit
npm run build
npm run verify:fixture
```

`npm test` is the frontend suite. It does not run Anchor tests. `npm run check` combines frontend lint, tests and production build. `verify:fixture` uses live devnet RPC to check the public mint; it can fail during RPC outages even when offline tests pass.

## Existing onchain toolchain

| Tool | Project version |
|---|---|
| Anchor | 1.2.0 (`Anchor.toml`) |
| Solana CLI | 4.2.2 (`Anchor.toml`) |
| Rust | 1.89.0 (`rust-toolchain.toml`) |
| Node.js / npm | 24.x / 11.x |

Use Linux/macOS or WSL on Windows for Anchor. Keep Windows and WSL dependency installations separate when native packages differ. A Linux/WSL checkout needs its own `npm ci`; do not copy Windows `node_modules` into it.

From an already configured local workspace with the matching local program identity and provider wallet:

```bash
NO_DNA=1 anchor build
NO_DNA=1 anchor test --validator legacy --provider.cluster localnet
```

`Anchor.toml` defaults to localnet deliberately. These tests create local mock mints and token accounts; they do not use real USDC or devnet balances. `NO_DNA=1` keeps the optional toolchain DNA reporting disabled.

## Clean clone without the original program keypair

Private program/deployer keypairs are not distributed. Do **not** ask for a keypair or change the tracked program ID just to run tests. A local validator can load the compiled binary at its public program address without the deployment keypair.

Build inside Linux/WSL:

```bash
npm ci
NO_DNA=1 anchor build
```

Prepare a dedicated **local-test-only** wallet outside the repository if you do not already have one. This writes a secret key file locally; never display or upload its contents:

```bash
mkdir -p "$HOME/.config/solana"
solana-keygen new --silent --no-bip39-passphrase --outfile "$HOME/.config/solana/qazsplit-local-test.json"
```

Do not overwrite an existing wallet; skip generation if that file already exists. In terminal A, start a fresh local ledger (the temporary path is printed; no existing ledger is deleted):

```bash
qaz_test_ledger=$(mktemp -d /tmp/qazsplit-local-ledger.XXXXXX)
solana-test-validator --ledger "$qaz_test_ledger" --bpf-program 3zqHQ8gWY2o8ZtfaGZg5JvgntkV6Qdf9zKBrJqufhKJD target/deploy/qazsplit.so
```

Once RPC is ready, run in terminal B from the same repository:

```bash
solana airdrop 10 --url http://127.0.0.1:8899 --keypair "$HOME/.config/solana/qazsplit-local-test.json"
NO_DNA=1 anchor test --skip-build --skip-deploy --skip-local-validator --provider.cluster localnet --provider.wallet "$HOME/.config/solana/qazsplit-local-test.json"
```

Stop terminal A with Ctrl+C after tests. This path does not deploy to devnet and does not alter the existing devnet addresses. IDL and TypeScript types are generated under ignored `target/` during build. Do not run the operational `scripts/devnet-*-demo.ts` scripts for ordinary local tests; they require the maintainer's external signing directory.

## Optional public settings

Defaults are in [constants.ts](../app/src/lib/constants.ts). No settings are required for the normal demo.

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SOLANA_RPC_URL` | Optional devnet RPC endpoint; the app checks devnet genesis before transactions |
| `NEXT_PUBLIC_QAZSPLIT_PROGRAM_ID` | Optional program override; leave unset for the published demo |

Next.js reads optional local frontend settings from `app/.env.local`. Every `NEXT_PUBLIC_*` value is public in the browser bundle. Never put private RPC credentials, private keys or seed phrases in it. The mock mint remains fixed to `7S3HyHeoD9WvVt63frsvRU9Kcixw2bRDAeyD8tVC6w8H`.

## Vercel

The existing frontend uses Root Directory `app`, Next.js preset and its standard build command. Build using the committed workspace lockfile and include optional platform dependencies; Windows-only native dependencies must not be copied to Linux. No backend, database or deployer secrets are needed. See the existing [CI workflow](../.github/workflows/ci.yml) and [dated release report](../reports/history-devnet-verification.md); this documentation change does not redeploy the onchain program.
