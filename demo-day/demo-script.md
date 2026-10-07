# QazSplit: 60–90 second demo

Use the plain-spoken version below. Target 80 seconds including clicks; rehearse with a timer. This is a hypothetical team, not a customer testimonial. Only devnet and Mock USDC appear on screen.

## Before speaking

Open the deck, a prefilled Create Split tab, the existing Pay Split tab, and the known-good Explorer transaction from [the checklist](checklist.md). Team setup is a separate transaction; the live centerpiece is one payer-signed payment. Do not spend stage time typing addresses. No new transaction was signed during preparation of these assets.

## Spoken script and screen cues

| Time | Screen/action | Say |
|---|---|---|
| 0–10 s | Title; switch to Create Split | “Imagine a developer, designer, and manager finishing one client project. They agree on fifty, thirty, and twenty percent. Who receives the payment and pays everyone else?” |
| 10–23 s | Point to the three prefilled recipients and 100% total | “QazSplit lets the client pay the team directly. The team creates a fixed allocation first. This setup is separate from the payment; nobody needs to hold the team's funds.” |
| 23–34 s | Open the already-created Pay Split; amount 10 | “Here is that split. Ten Mock USDC becomes five, three, and two. This is Solana devnet: test tokens, no real money.” |
| 34–47 s | Click Simulate payment; show passed state | “We simulate before requesting a signature. The program checks the recorded recipients and mint, then makes the transfers in one atomic transaction.” |
| 47–60 s | Click Sign atomic payment; presenter approves in their wallet | “The client approves one payment transaction. If any transfer fails, all token transfers roll back. A failed transaction can still cost a network fee.” |
| 60–73 s | Show success and recipient balance deltas; Explorer | “Now check the result, not just the green banner: each recipient balance increased by five, three, and two. Explorer gives us the transaction receipt.” |
| 73–85 s | Closing slide | “Our focus is small-team payments without a deposit-and-distribute step. The devnet flow works. Customer demand is our next question. We'd like feedback from teams already paid on Solana.” |

If confirmation takes more than 10 seconds, switch to the prior receipt and say: “Devnet is taking longer today. This is our previously verified transaction, not the transaction currently pending.” Never describe a pending transaction as successful.

## Short answer: why Solana?

“Solana is the settlement layer, not a percentage calculator. The config records the allocation onchain, and the Token Program executes every payout under one payer signature. Solana's atomic execution prevents partial team payments. Other smart-contract chains can do this too; we chose Solana-native wallets and token rails for teams already in this ecosystem.”

## Short answer: differentiation

“Splitting itself isn't new. Fideox describes a project treasury; Splitter uses vaults; SplitPact offers broader graph-based routing. QazSplit deliberately targets a smaller task: one client pays two to five recipients directly against a fixed allocation. That is a workflow difference, not a proven business moat.”
