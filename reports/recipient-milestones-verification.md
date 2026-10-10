# Recipient approvals, milestones, and receipts

Verification date: 2026-10-10.

## Current status

Implementation and local verification pass. **The updated program is deployed to devnet and the complete approval/milestone demo passed on 2026-10-10.** The user authorized deploying these changes together with wallet history. The dedicated demo signers were used; no personal Phantom wallet was used for this demo.

Deployed binary SHA-256 (verified byte-for-byte against the tested build): `958c32c2eb10b80789558e50dd1e4741648ae3c991d91d0f7ee746322086abc1`.

Upgrade signature: `26LNBQybhUASabrZ4XEUHmEX7phiaP8ugQKnNiAwX1HKXjGN4LB9VWHngLRr1jRKZztcYijQ7kajCKBEy9w5waJZ` (finalized, slot 509566811). Initial HTTP-RPC buffer writes hit public RPC limits; the existing buffer was resumed successfully using the CLI TPU client. The old binary was backed up outside the repository.

Known-good agreement: `A7MyBg1Ao9dSdXExBJxGop8mvjD2NuwGbDdeTj6WwGkU`.

Known-good Design payment: `294e2R8p756e6VeCUZmBoSHB5HNv16brkrs21TUTfNuG9uDiVcFtWemWjHcED7yHfpNMRx7qeS7z5BmiYv9kWJH6`. Recipient deltas are exactly 5 / 3 / 2 mock USDC; resulting balances 25 / 12 / 10. Approval mask 7, Design Paid, one payer signature and three direct token CPIs.

For the subsequent history/frontend publication verification, see `history-devnet-verification.md`.

Local checkpoints: `checkpoint/pre-approvals-milestones-20261010` and `checkpoint/pre-history-devnet-20261010` at the pre-change commit. Implementation was committed and pushed as `da111715568b9383b63ff317db6755c745140064`. Both connected Vercel sites published successfully. The user's unrelated `.superstack/` and pitch-deck HTML were left untouched and excluded from publication.

## Compatibility and state

The original 253-byte `SplitConfig`, `create_split`, and `execute_split` remain compatible. Existing payment URLs still use the original payment component. New proposals use a separate `SplitAgreement` discriminator and PDA:

`[b"agreement", creator, split_id.to_le_bytes()]`

`SplitAgreement` occupies 705 bytes including its 8-byte discriminator:

| Field | Type / meaning |
|---|---|
| version | u8, currently 1 |
| creator, mint | Pubkey, immutable |
| split_id | u64, immutable PDA identifier |
| recipient_count | u8, 2–5 |
| recipients | [Pubkey; 5], immutable, unique |
| shares_bps | [u16; 5], positive, total exactly 10,000 |
| bump | u8, canonical PDA bump |
| approval_mask | u8, one bit per recipient |
| milestone_count | u8, 1–5 |
| milestones | [Milestone; 5] |

Each milestone contains `name_len: u8`, `name: [u8; 32]` (UTF-8), immutable `amount: u64` in six-decimal token units, and payment records `paid: bool`, `payer: Pubkey`, `paid_at: i64`, `paid_slot: u64`.

Active is derived from all configured approval bits being set. Terms cannot be edited even while Pending. No mutation, cancellation, custody, vault, escrow, backend, database, or indexer was added.

## New instructions

- `propose_split(split_id, recipients, shares_bps, milestones)`: creator signs, pays account rent, fixes all terms, starts Pending. Requires a classic SPL mint with six decimals.
- `approve_split()`: configured recipient must be a transaction signer; sets only that recipient's bit. Rejects outsiders, missing signatures, and duplicate approval.
- `pay_milestone(milestone_index)`: requires all approvals and an unpaid valid milestone. Amount comes from immutable onchain terms, not the paying client's arguments. Performs direct payer-authorized `transfer_checked` CPIs, then records payment. Every CPI and the paid state commit or roll back together. Rejects repeat payment.

Distinct account types prevent calling legacy `execute_split` on an agreement to bypass approvals or milestone tracking.

## Frontend

Create Split now proposes recipient shares plus 1–5 named fixed-amount milestones. The same `/pay/[split]` route detects legacy versus agreement accounts. Agreement pages display recipient approval progress, Pending / Active / Locked state, milestone selection and Unpaid / Paid status. Each recipient approves their own share; an active milestone is simulated before one client-signed atomic payment.

Receipts display the milestone name, total, every full recipient address and exact allocation, payment signature, devnet Explorer link, onchain timestamp (or event-time client timestamp while refreshing), and “QazSplit never held the funds”. A reloaded paid milestone recovers its signature from RPC history and verifies the successful payment instruction, agreement, payer, milestone index, and paid slot. No signature or receipt database is required.

The existing wallet connection, version-0 fallback / version-1 support, devnet genesis guard, mock mint, direct token transfers, integer rounding, and visual style remain in use. Exact token-unit amounts take precedence over approximate display rounding.

## Verification results

- `anchor build`: PASS using existing WSL / Anchor 1.2.0 / Solana 4.2.2 toolchain.
- Full local Anchor suite: **26 passing** (9 unchanged legacy tests + 17 agreement tests).
- Includes valid 50/30/20, recipient count boundaries, total/duplicates/zero shares, UTF-8 name limits, zero amounts, decimals, Pending payment rejection, unauthorized/missing/duplicate signatures, 2-of-3 gating, immutable terms, legacy bypass rejection, wrong mint/account ordering/count, one payment signer, exact rounding, insufficient balance, repeat-payment protection, and rollback of both paid state and all token balances after a final-recipient failure. The latter is submitted to the local validator with preflight skipped to exercise an actual failed local transaction.
- Frontend `npm test`: **109 passing across 10 files**, including the subsequent history tests.
- `npm run lint`: PASS.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS on Windows; Linux/WSL production build also passed.
- Headless Edge browser checks at 375 / 768 / 1280 px: new proposal form, real legacy devnet payment link, mocked new-account Pending / 2-of-3 / Active / Paid receipt states; no hydration warnings, page exceptions, or horizontal overflow. These fixture checks did not sign or send transactions and are **not** evidence of a new devnet payment.

## Exact repository files changed / added

Modified:

1. `package.json`
2. `programs/qazsplit/src/constants.rs`
3. `programs/qazsplit/src/errors.rs`
4. `programs/qazsplit/src/state.rs`
5. `programs/qazsplit/src/lib.rs`
6. `programs/qazsplit/src/instructions/mod.rs`
7. `app/src/app/page.tsx`
8. `app/src/app/pay/[split]/page.tsx`
9. `app/src/components/create-split-form.tsx`
10. `app/src/components/create-split-form.test.ts`

Added:

11. `programs/qazsplit/src/instructions/propose_split.rs`
12. `programs/qazsplit/src/instructions/approve_split.rs`
13. `programs/qazsplit/src/instructions/pay_milestone.rs`
14. `tests/agreement.ts`
15. `app/src/lib/agreement-client.ts`
16. `app/src/lib/agreement-client.test.ts`
17. `app/src/components/agreement-form.tsx`
18. `app/src/components/agreement-form.test.ts`
19. `app/src/components/split-payment.tsx`
20. `reports/recipient-milestones-verification.md`

Generated, ignored build outputs: `target/deploy/qazsplit.so`, updated Anchor IDL/types, and frontend `.next` artifacts. No dependency versions, lockfile, existing devnet addresses, private keys, or seed phrases were changed.

## Devnet target and completed verification

Program (existing address, upgraded): `3zqHQ8gWY2o8ZtfaGZg5JvgntkV6Qdf9zKBrJqufhKJD`

Mock mint (unchanged): `7S3HyHeoD9WvVt63frsvRU9Kcixw2bRDAeyD8tVC6w8H`

New known-good payment signature: `294e2R8p756e6VeCUZmBoSHB5HNv16brkrs21TUTfNuG9uDiVcFtWemWjHcED7yHfpNMRx7qeS7z5BmiYv9kWJH6`. This is a new milestone payment, not an old legacy transaction.

The completed verification is a 10 mock-USDC Design payment from dedicated demo payer `HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ` to the existing recipients (5 / 3 / 2 mock USDC):

- `aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX`
- `FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8`
- `35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq`

Dedicated deployer / fee payer for the upgrade and agreement rent: `4pnW63g4sqPgTJvBeEzaeC1Hx8eKSpxVzEPonBGfUmna`. Recipient approvals require their own signatures. The personal Phantom wallet is excluded. CLI configuration was verified as devnet; the upgrade authority matches this dedicated deployer. Test SOL already exists, so no airdrop is needed for the proposed bounded operations.

Recipient funding executed under the later deployment/demo authorization: **0.00066 devnet SOL each**, covering the reported empty-system-account rent minimum of 0.00065024 SOL plus an approval fee. Funding transaction: `31ZJ6iCb6gGJTYtGzvHD9yEMFqnxbVfKoTrhJNsFcNqitpNtRWejAehkgbXD9czkZZKHWcbuoZJgbeuB8Xsk2dDo`.

## 60-second demo (verified on devnet)

Prepare recipient wallets and the demo payer before recording; use devnet only, with mock tokens and small test-SOL balances. The already verified example has Design paid; Development (20 mock USDC) and Launch (10 mock USDC) remain unpaid. Do not try to repay Design.

| Time | Action / evidence |
|---|---|
| 0–10s | Show 50/30/20 recipients and fixed Design / Development / Launch milestone amounts. |
| 10–20s | Simulate and sign Propose split. Open the same approval / payment link; show Pending and 0 of 3. |
| 20–35s | Three recipients approve with their own wallets; show 1/3, 2/3, then Active / Locked at 3/3. |
| 35–45s | Connect the demo payer, select Design for 10 mock USDC, show 5 / 3 / 2 preview, simulate. |
| 45–55s | Sign one atomic payment; show Design Paid and refreshed recipient balances. |
| 55–60s | Show the receipt and open its devnet Explorer transaction; point out the direct transfers and no-custody message. |

This remains a devnet hackathon prototype, not an audited mainnet release. The existing upgrade authority remains in place. Do not publish or use the new proposal flow against the old program before the upgrade is verified.
