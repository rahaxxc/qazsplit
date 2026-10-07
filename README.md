# QazSplit

QazSplit is a devnet-only hackathon MVP for one client-signed, non-custodial Mock USDC payment split across 2–5 recipients.

## Safety boundary

- Devnet and test tokens only.
- No mainnet or real money.
- No vault, custody, escrow, backend, database, login, or indexer.
- No user private keys or seed phrases are accepted or stored.
- The frontend simulates before enabling the wallet signature action.

## Architecture

`SplitConfig` is an immutable PDA derived from `split`, creator, and split ID. It records one classic SPL Token mint, 2–5 unique recipients, and shares totaling exactly 10,000 basis points. `execute_split` validates every recipient token account before calling `transfer_checked` directly from the payer token account. All CPIs execute inside one Solana transaction, so any failure rolls back every transfer.

The frontend contains only:

1. Create Split
2. Pay Split

## Verified toolchain

| Tool | Project version | This Windows host |
|---|---:|---:|
| Node.js | 24 LTS | 24.11.1 |
| npm | 11 | 11.6.2 |
| Anchor | 1.2.0 | Missing; WSL required |
| Solana CLI | 4.2.2 | Missing; WSL required |
| Rust | 1.89.0 | Missing; WSL required |

Anchor's official Windows instructions require WSL. The native Windows frontend checks pass; the on-chain build and integration suite must be run inside WSL before any devnet deployment is prepared.

## Local checks

From the repository root:

```bash
npm install
npm run lint
npm test
npm run build
npm run verify:fixture
```

After the WSL toolchain is installed:

```bash
NO_DNA=1 anchor build
NO_DNA=1 anchor test
```

Do not run a deploy command until both commands pass. `Anchor.toml` stays on `localnet` for that reason.

## Mock USDC fixture

The checked fixture uses Solana devnet mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. A read-only RPC check confirmed that it is an initialized classic SPL Token mint with six decimals. It has no real-money value in this MVP.

