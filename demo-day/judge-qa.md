# Judge Q&A

## Why does this need Solana?

Percentage math does not need a blockchain. The selected promise does: a payer-authorized, publicly verifiable allocation and settlement of SPL tokens without an app custodian. SplitConfig stores recipients, mint and basis points; the program invokes the Token Program, and all payouts commit together. Solana is necessary to this implementation, not uniquely necessary to the product category. A bank-based product could serve users who do not want crypto. [Solana transactions](https://solana.com/docs/core/transactions), [PDAs](https://solana.com/docs/core/pda), [CPIs](https://solana.com/docs/core/cpi).

## Isn't this just Fideox / Splitter / SplitPact?

The overlap is real. Do not call percentage splitting novel.

| Project | Evidence-backed emphasis | QazSplit's narrower choice |
|---|---|---|
| [Fideox](https://colosseum.com/projects/explore/fideox) | Historical submission: USDC team splits with deposit/distribute and an indexer. Archived pitch describes escrowed project treasuries and wallet authentication. | Direct payer-to-recipient transfers; no project treasury, login or indexer. |
| [Splitter](https://github.com/mertizal/Web3-Splitter) | Public repository describes SPL-token vault deposits and percentage withdrawals; archived source includes update/claim operations. | A fixed SplitConfig and payouts in the payer's transaction, not a vault deposit followed by claims. |
| [SplitPact](https://splitpact.com/) | Current site advertises graph-based business routing, caps, thresholds, time gates and an MCP builder. Historical demo deposits test tokens then manually triggers distribution. | No graph, conditions or deposited balance; two simple flows for two to five recipients. |

This establishes architectural/workflow differences, not competitive superiority. Fideox's current product status was not independently verified. SplitPact's current marketing describes automatic routing while the archived demo used a manual flush; do not present the archive as its current capability limit. The broader simplicity/non-custodial claim is not exclusive to QazSplit. Sources and dates: [evidence](evidence.md).

## Why a custom program rather than three ordinary transfers?

A wallet could batch ordinary transfers atomically. QazSplit's program adds persistent, onchain recipient/mint/share rules and checks them at execution rather than relying only on frontend calculations. This does not make the percentages novel or prevent the payer from paying elsewhere.

## Does money pass through QazSplit?

No. Transfer source is the payer's token account; destinations are recipient token accounts. The PDA holds configuration, not a token treasury. Account rent and SOL fees are separate from the token payment.

## Is it really automatic?

Only once the payer submits the QazSplit payment transaction. There is no watcher, scheduler or keeper. Sending tokens to a random address or directly to the config PDA will not automatically split them. Say “one approved payment distributes to the team,” not “any incoming payment automatically splits.”

## Does everyone sign the agreement?

No. The creator records the allocation after agreement outside the app. Recipients do not sign it in this MVP. The payer can inspect the stored allocation before signing payment. Do not call it a cryptographically co-signed agreement.

## Can the creator change shares after payment?

The current program exposes only create_split and execute_split; no update or delete instruction. A changed allocation requires a new config/payment link. This is config immutability under the current code. The devnet deployment retains upgrade authority, so do not claim absolute immutability or censorship resistance.

## What if one recipient transfer fails?

The transaction fails and earlier token transfers revert. Local tests include a later failed CPI after an earlier transfer and verify unchanged balances. A processed failure can still incur a SOL transaction fee. Simulation helps catch failures but is not a settlement guarantee.

## What about rounding?

All calculations use integer base units. For six-decimal Mock USDC, floor each non-final allocation; give the final recipient the remainder. Example: 10.000001 at 50/30/20 becomes 5.000000, 3.000000 and 2.000001. No token units disappear; very small payments can produce zero allocations for some recipients.

## What validation exists?

Two to five unique recipient addresses, positive shares totaling exactly 10,000 basis points, and Token Program account/mint/owner checks. The frontend is restricted to the approved mock mint. The program itself accepts classic SPL mints at creation; do not claim it hardcodes real USDC or the devnet cluster. The UI's network guard is not a universal program-level mainnet prohibition.

## What's actually proven?

A devnet payment with one payer signature and recipient token increases of 5/3/2; a previously completed browser flow using a test Wallet Standard bridge; historical local Anchor/Rust tests; and current frontend lint/tests/build checks documented in the preparation result. Those prove implementation behavior within tested conditions, not audit status, customer adoption, demand or production reliability.

## What's not ready?

Real money, mainnet, security audit, recipient consent collection, changing allocations, fee abstraction and support processes are outside the approved scope. No backend, database, login or indexer was added. This preparation changes none of that.

## Who is the first user, and how do you make money?

The proposed first user is a small freelance/team group already receiving Solana token payments. No verified customers, revenue or willingness-to-pay evidence was supplied. The MVP has no protocol fee. Pricing is unvalidated; avoid presenting a hypothetical fee or market-size estimate as a business result.

## Why won't users just make manual transfers?

They may. Our hypothesis is that fixed onchain allocations and one payer approval reduce coordination for repeat small-team payments. We have not measured this benefit. Feedback should compare against manual/batched transfers and existing splitters, not assume adoption.

## Do you store keys or guarantee refunds?

No private keys or seed phrases in app code, chat or deck. Wallets authorize transactions. Successful token transfers are not reversible by QazSplit; there is no escrow, dispute mechanism or refund function. A demo uses only devnet test tokens.
