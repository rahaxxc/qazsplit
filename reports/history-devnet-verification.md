# Wallet history and devnet release

Verification date: 2026-10-10. Devnet and mock USDC only.

## Scope

Added `/history`, linked from the app shell. Connected wallets can find agreements as creator, recipient or payer, inspect Pending / Active / Locked approval progress and Unpaid / Paid milestones, reopen agreements, expand exact payment receipts, and open devnet Explorer transactions. Legacy SplitConfig agreements and direct payments remain supported.

No new onchain state or instruction was needed for history. No database, login, indexer, custody, escrow, dependency changes or address changes. Browser-only wallet state renders after hydration. Existing style/tokens, accessible native links/buttons/details, reduced-motion skeletons, and exact bigint token formatting are retained.

History enumerates the program's two known account sizes with the configured mock mint, verifies ownership/discriminator/version/PDA/recipient shares, and pages confirmed program signatures five at a time. It verifies successful top-level payment instructions, mint, real payer signer, agreement, milestone index and paid slot before displaying a receipt. Failed or unrelated transactions are excluded. Older activity is explicit via Load older activity; null/pruned RPC transactions are reported as incomplete history, not an empty complete archive. Public devnet retention and RPC rate limits still apply; this is not a permanent external archive service.

## Local checks

- Anchor build: PASS.
- Full local Anchor suite: 26 passing (9 legacy + 17 agreement).
- Frontend suite: 109 passing (84 existing + 18 history-client + 7 history-UI).
- Frontend lint and TypeScript: PASS, no lint warnings.
- Windows and Linux production builds: PASS; `/history` is present.
- Read-only live RPC check recovered the personal wallet's three existing agreements and two old 10-mock-USDC payments before the new demo. No wallet signature was needed to read them.

## Real devnet demo

Program: `3zqHQ8gWY2o8ZtfaGZg5JvgntkV6Qdf9zKBrJqufhKJD` (unchanged).

Mint: `7S3HyHeoD9WvVt63frsvRU9Kcixw2bRDAeyD8tVC6w8H` (unchanged, six decimals).

Agreement: `A7MyBg1Ao9dSdXExBJxGop8mvjD2NuwGbDdeTj6WwGkU`.

- Proposal: `5K8uKaca2222aRyZwvfjuvhuz3CY4kP2EpDxRmCZFTRXFYay5hzf4uVTE9XtWXK7NmJWq3dKtTb4Ya8nTUi2GzAs`.
- Recipient 1 approval: `o9qxBNSb5KiVXHYFR3xyEEitvKXG96CLVL5Znek21axNvofTwVYKtU6toJ35S9JtYugLZn1C9te4PGGXEBiJecm`.
- Recipient 2 approval: `29rTqjXe3gu5UvMJ5VEU1yGwnMRvKQgv7AqPjGPdU3DphnnCyG447gsU763UTDeDoTofViVAPJkQofoEvz3hHqAw`.
- Recipient 3 approval: `412gCknogVFEeXjXnerZS5Sna4VGiz7gdN8EXyaQYQcvuPsoCdDagcugiM1xMuvM3GqKKP4u9D5pUs289k9pS6jq`.
- Payment: `294e2R8p756e6VeCUZmBoSHB5HNv16brkrs21TUTfNuG9uDiVcFtWemWjHcED7yHfpNMRx7qeS7z5BmiYv9kWJH6`.

All steps simulated before sending. Actual progress 1/3 Pending, 2/3 Pending, 3/3 Active. Design paid once for 10 mock USDC, exact deltas 5 / 3 / 2, resulting recipient balances 25 / 12 / 10. One payment signer, three direct token transfers, no vault. The dedicated payer still has 70 mock USDC. The personal Phantom's 100 mock USDC were not spent by this verification.

The dedicated external signing directory is required by `scripts/devnet-agreement-demo.ts`; no keys or seed phrases are included. Without `--execute`, the script is read-only. It uses a fixed demo agreement identifier to avoid duplicate proposals/payments on rerun and never mints extra tokens.

## Exact additional files for history / release verification

- `app/src/app/history/page.tsx`
- `app/src/components/app-shell.tsx`
- `app/src/components/wallet-history.tsx`
- `app/src/components/wallet-history.test.ts`
- `app/src/lib/history-client.ts`
- `app/src/lib/history-client.test.ts`
- `app/src/lib/qazsplit-client.ts` (extract existing validated decoder for reuse only)
- `scripts/devnet-agreement-demo.ts`
- `reports/history-devnet-verification.md`
- `reports/recipient-milestones-verification.md` (update previous pending deployment status)

The previous approval/milestone implementation file list remains in its report. User-owned `.superstack/` and the unrelated pitch-deck HTML are excluded from publication.

## Browser / frontend publication

Pending final browser check and GitHub/Vercel publication at the time this draft was created. Do not interpret the completed onchain upgrade as proof the public frontend is already updated.
