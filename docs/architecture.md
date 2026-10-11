# Architecture

QazSplit is a devnet-only, non-custodial team-payment prototype. No application server, database, indexer, token vault or escrow is involved. The source of truth is Solana account state and successful transactions.

## Account compatibility

| Account | PDA seeds | Size including discriminator | Purpose |
|---|---|---:|---|
| `SplitConfig` | `split`, creator public key, little-endian u64 split ID | 253 bytes | Original immutable allocation; legacy payment URLs remain supported |
| `SplitAgreement` | `agreement`, creator public key, little-endian u64 split ID | 705 bytes | New recipient-approved agreement with fixed milestones |

The account discriminators and seeds are distinct. A new agreement cannot use the legacy `execute_split` instruction to bypass approvals or milestone payment tracking.

## Agreement state

See [state.rs](../programs/qazsplit/src/state.rs).

| Field | Type / rule |
|---|---|
| `version` | u8, currently 1 |
| `creator`, `mint` | Pubkey; fixed on creation |
| `split_id`, `bump` | u64 identifier and u8 canonical PDA bump |
| `recipient_count`, `recipients` | 2–5 configured unique wallets in a five-Pubkey array |
| `shares_bps` | Five u16 values; configured shares positive and total exactly 10,000 |
| `approval_mask` | One approval bit per configured recipient |
| `milestone_count`, `milestones` | 1–5 configured milestones in a five-element array |

A milestone contains its UTF-8 name (1–32 bytes), a positive u64 token amount, `paid`, `payer`, `paid_at` and `paid_slot`. Amounts are integer six-decimal token units.

Recipient addresses, shares, mint, milestone names and amounts are fixed **from proposal creation**, including while Pending. Only approval and payment records change. There is no edit, cancellation or recipient-replacement instruction.

```text
Pending, 0/N approvals
  -> recipients sign approve_split separately
Pending, fewer than N approvals: payment rejected
  -> final configured recipient signs
Active / Locked: each Unpaid milestone may be paid once
  -> successful atomic pay_milestone
That milestone is Paid; other milestones retain their own status
```

`Active` is derived from all configured approval bits being set, not from a separate client-controlled status flag. Approval records consent; it transfers no tokens and does not establish proof of delivery or a legal agreement.

## Instructions

| Instruction | Authorization and effect |
|---|---|
| `propose_split(split_id, recipients, shares_bps, milestones)` | Creator signs and funds account rent; validates and fixes terms; starts with zero approvals |
| `approve_split()` | Configured recipient signs; sets only their bit; outsiders and duplicates rejected |
| `pay_milestone(milestone_index)` | Payer signs; all approvals required; amount loaded from an unpaid onchain milestone; direct token CPIs followed by payment record |
| `create_split(split_id, recipients, shares_bps)` | Original immutable `SplitConfig` creation; retained for compatibility |
| `execute_split(amount)` | Original direct payment according to a legacy config; no milestone/approval semantics |

## Atomic settlement and rounding

[pay_milestone.rs](../programs/qazsplit/src/instructions/pay_milestone.rs) validates recipient account count, writable status, Token Program ownership, mint and recipient owner/order. It calls `transfer_checked` from the payer's token account to each recipient's token account. No PDA owns, receives or delegates the payer's tokens.

All CPIs and the milestone Paid record execute in one Solana transaction. A failure rolls back earlier token movements and payment state; network fees may still apply.

[math.rs](../programs/qazsplit/src/math.rs) uses integer arithmetic. Each recipient except the last receives `floor(total_units * share_bps / 10_000)`. The final recipient receives the remainder, ensuring allocations sum exactly to the input amount. For 20 mock USDC at 50/30/20, payouts are 10/6/4. For 10.000001, payouts are 5/3/2.000001.

## Frontend, receipts and history

The Next.js app has Create Split, `/pay/[split]` and `/history`. The payment route detects legacy versus agreement account layouts. The frontend uses Wallet Standard through Solana Kit, checks devnet's genesis hash and restricts its demo UI to the configured mock mint. Transaction compatibility code selects supported wallet transaction versions.

Receipts combine fixed onchain allocation terms and payment records with the matching successful RPC transaction signature. Milestone timestamps come from the onchain clock when available; an immediate client-side timestamp is a fallback, not a server-rendered value.

[history-client.ts](../app/src/lib/history-client.ts) reads known program account layouts and pages program signatures. It filters failed/unrelated transactions and checks the program, instruction, mint, payer signer, milestone index and paid slot before accepting payment evidence. Five-signature pages avoid large public-RPC bursts. Missing/pruned transactions are incomplete history, not proof that no payment occurred.

## Trust boundary

No user private keys or seed phrases are accepted or stored by the app. Users authorize transactions in their wallets. This is not an independent security audit. The devnet program is upgradeable; immutable agreement fields do not imply immutable executable code. Mainnet, Token-2022, real USDC, vaults, escrow and dispute resolution are outside the current product boundary.
