# Demo evidence and claim boundaries

Prepared 2026-10-06 (Asia/Qyzylorda); external checks 2026-10-05 UTC. This is not an audit or a customer-validation report.

## QazSplit evidence

Current inspected files: `programs/qazsplit/src/lib.rs`, `instructions/create_split.rs`, `instructions/execute_split.rs`, `math.rs`, `state.rs`, `tests/qazsplit.ts`, `app/src/lib/constants.ts`, `fixtures/devnet.mock-usdc.json`.

Observed source: only create_split and execute_split instructions; config PDA; 2–5 unique recipients and positive shares totaling 10,000 bps; transfer_checked from payer directly to recipient accounts with propagated errors. No update instruction or token vault in this program. The frontend reads config directly from RPC and retains existing simulation/signature flow.

Read-only `getTransaction` recheck against `https://api.devnet.solana.com`, commitment confirmed, maxSupportedTransactionVersion 1, returned the known-good receipt at slot 507827153, `meta.err = null`, one signature and fee 5,000 lamports. That fee is this historical transaction's fee, not a quote for future transactions or a real-money cost claim.

| Owner/role | Pre base units | Post base units | Delta Mock USDC |
|---|---:|---:|---:|
| Payer `Hnmu…jaEQ` | 100,000,000 | 90,000,000 | −10 |
| Developer `aXCZ…35JX` | 0 | 5,000,000 | +5 |
| Designer `FDFu…41S8` | 0 | 3,000,000 | +3 |
| Manager `35DN…ZoUq` | 0 | 2,000,000 | +2 |

Mint `7S3HyHeoD9WvVt63frsvRU9Kcixw2bRDAeyD8tVC6w8H`; six decimals. [Public devnet transaction receipt](https://explorer.solana.com/tx/5eLd2QhjL2YDR2c84EQjNYxV5EKUjFnoorsERQBZEksrRgaanvem9PUSMbLriEaKZqerzf1EZtuj1WqefZWVrV7s?cluster=devnet). This old receipt is the fallback, not evidence of a new payment during asset preparation.

Prior verified project work reported 9 Anchor integration tests and 3 Rust unit tests passing. The current task does not change or rerun the program; these are historical results. The nine integration cases in current source cover creation, invalid total, duplicates, wrong mint, 50/30/20 payout, rounding, insufficient balance, later-CPI atomic rollback and unauthorized mutation. Current frontend checks and browser results are recorded in [preparation result](preparation-result.md).

## Competitor sources

Colosseum authenticated read-only project records fetched 2026-10-05 19:06 UTC; project sync dates 2026-09-29, archive ingestion 2026-10-05. The summaries are archive analyses, not independent execution of competitor products. No winner filter was used; no winner status is used in the pitch.

- [Fideox submission](https://colosseum.com/projects/explore/fideox): description reports onchain contributor percentages, deposit/distribute, Next.js/Anchor and an indexer. Archived [pitch](https://youtu.be/RK5Mg1ACYjM), indexed 2026-09-19, describes project escrow treasuries and wallet authentication. Live `fideox.com` and its Colosseum public page were inaccessible to the web tool. Current deployment, maintenance and adoption are unknown. Do not infer inactivity or failure.
- [Splitter source repository](https://github.com/mertizal/Web3-Splitter): current public README describes vault deposits and withdrawals. Colosseum archive sampled 33 selected files, captured 2026-09-25; it describes vault/update/deposit/claim instructions. This is the Radar project by mertizal, not another similarly named splitter app. We did not execute its tests or audit it; no performance/security comparison is claimed.
- [SplitPact current site](https://splitpact.com/), checked 2026-10-05 UTC: advertises devnet graph routing, business allocation conditions and an MCP builder. These are publisher claims, not audited functionality. [Historical technical demo](https://youtu.be/naLmHwYPTpQ), archived/indexed 2026-09-19, describes depositing sUSD and signing Distribute. The newer site's automatic-routing language and earlier manual demo are scoped separately. Do not claim it currently lacks automation, non-custodial operation or working payouts.
- The Grid's public GraphQL endpoint `https://beta.node.thegrid.id/graphql` was checked over verified HTTPS for product names and organization/root slugs containing Fideox, Splitter or SplitPact. Both results were empty with no GraphQL errors. This is a corpus coverage gap, not evidence the projects do not exist.
- Bounded public web searches checked all three names. No unrelated “Split” product was substituted for a named project. No paid research, uploads, project submissions or external messages were made.

## Why Solana: authoritative sources

- [Transactions](https://solana.com/docs/core/transactions): atomic execution; state changes revert on failure while fees can still be charged.
- [PDAs](https://solana.com/docs/core/pda): deterministic program/seed-derived addresses support retrievable allocation state.
- [CPIs](https://solana.com/docs/core/cpi): a program can invoke another program's instructions; QazSplit uses that mechanism for checked Token Program transfers.

These support the architecture explanation, not a claim that Solana is the only chain with atomic settlement. No unmeasured TPS, latency, user savings or mainnet cost figure appears in the pitch.

## Not established

Customer interviews, paying users, retention, revenue, quantified savings, founder experience/testimonials, pricing, market size and exclusive defensibility were not supplied or established. The intended small-team segment and manual-forwarding pain are hypotheses. Current hackathon cohort/rules/deadlines were not supplied; no eligibility or award prediction is made. Devnet tests do not establish production readiness. No change to scope is recommended before this demo.
