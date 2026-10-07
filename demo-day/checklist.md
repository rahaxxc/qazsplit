# Demo checklist and fallback

## Start the existing frontend

No install, deployment, mint or faucet commands are needed for these assets.

```powershell
cd C:\Users\Rahat\Desktop\solana\qazsplit\app
npm run dev -- --hostname 127.0.0.1 --port 3000
```

For a quieter stage demo, after a successful build use `npm run start -- --hostname 127.0.0.1 --port 3000` instead. Run only one server on port 3000.

## Public reference values — never replace them for Demo Day

- Network: Solana devnet; six-decimal Mock USDC with no real value.
- Program: `3zqHQ8gWY2o8ZtfaGZg5JvgntkV6Qdf9zKBrJqufhKJD`.
- Mock mint: `7S3HyHeoD9WvVt63frsvRU9Kcixw2bRDAeyD8tVC6w8H`.
- Demo payer public address: `HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ`.
- Previously created UI demo link: [Pay Split](http://127.0.0.1:3000/pay/6MLR7q2EN9auNPR7d2gM7rCD9Ag426ScVqudieQA3yom).
- Known-good earlier receipt: [10 Mock USDC → 5 / 3 / 2](https://explorer.solana.com/tx/5eLd2QhjL2YDR2c84EQjNYxV5EKUjFnoorsERQBZEksrRgaanvem9PUSMbLriEaKZqerzf1EZtuj1WqefZWVrV7s?cluster=devnet). That receipt belongs to config `BpbTZ4W3Ud5LeD8GJYQgvqbu1hNrEb22xD6hQQ3szbeL`, not the UI demo link above.
- Receipt from the prior browser test bridge flow: [UI flow payment](https://explorer.solana.com/tx/4dXVRCuk4y4aeu9FouJ7ibXcaj31jyXcnNBqRBbaNn45SHLcnYprqJTM4Z5W2tsKwNE1SxfnXMSrAiusa3Niagju?cluster=devnet). This is historical evidence, not a live extension-wallet rehearsal.

| Role | Wallet to paste into Create Split | Share | Increase for one payment of 10 |
|---|---|---|---|
| Developer | `aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX` | 50% | +5 Mock USDC |
| Designer | `FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8` | 30% | +3 Mock USDC |
| Manager | `35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq` | 20% | +2 Mock USDC |

## Before the event

- [ ] Run lint, tests and build; confirm no contract or address changes.
- [ ] Open the HTML deck locally and verify slide navigation on the presentation laptop.
- [ ] Set the actual browser wallet to devnet, unlock it privately, and verify it supports the app's transaction version. Prior automated bridge testing is not proof that every wallet extension works.
- [ ] Use a wallet you already control in the extension; never import raw deployer/test-key files or reveal/export secrets for the demo. The demo payer address is public reference data, not a request for its key. If the funded test payer is not available in your extension, use the historical-receipt fallback rather than improvise a key import.
- [ ] Confirm the wallet has at least 10 of the exact mock mint plus enough existing devnet SOL for fees and any missing ATA rent. Check simulation. Do not buy SOL, use mainnet, substitute real USDC or top up tokens without separate authorization.
- [ ] Prefill Create Split using the table. Show this setup briefly; use the existing config for the stage payment so creation timing is not part of the 90-second path.
- [ ] Rehearse and record an end-to-end payment yourself only when ready to authorize a devnet test transaction. Save the recording locally; hide extension/desktop notifications and keep secrets off-screen. A new extension-wallet recording was not created by this preparation.
- [ ] Open the known-good Explorer receipt before the event. Save an offline screenshot/PDF of its Success status and token balance changes for network outages. Historical receipt data is also saved in [evidence](evidence.md).
- [ ] Test projector resolution and zoom; scroll only when needed. Hide speaker notes; turn off notifications.

## Stage sequence: five steps

1. Show the prepared 50/30/20 Create Split screen and explain immutable setup. Do not claim it was newly created if using the saved config.
2. Open the existing Pay Split link; verify three recipients, approved mint and amount 10.
3. Connect the payer wallet and click **Simulate payment**. Capture current balances as the baseline; confirm preview 5/3/2. Simulation must pass before signing.
4. Click **Sign atomic payment** once; inspect the wallet request and approve only devnet Mock USDC payment. If anything differs, reject. Creation, if demonstrated separately, has its own creator signature.
5. Wait for success, show balances increased by 5/3/2, and open the new signature's devnet Explorer link. Existing balances need not be zero. Do not re-use the old receipt as proof of this new click.

## Fallback decision table

| Failure | Presenter action | Honest line |
|---|---|---|
| Create setup takes too long | Use the already-created config | “This is our prepared split; setup was done earlier.” |
| Wallet unavailable/locked/version mismatch | Stop signing; show prior receipt or your saved rehearsal | “The live wallet isn't ready; this is our verified earlier run.” |
| Simulation fails | Do not sign; show the error and switch to evidence | “The safety check stopped this attempt.” |
| Pending for over 10 seconds | Inspect status once; switch tabs to prior receipt | “Today's transaction is still pending. This earlier receipt demonstrates the completed flow.” |
| Network/Explorer unavailable | Show a clearly labeled saved recording or historical evidence table | “This is recorded evidence, not a live result.” |
| Confirmation uncertain | Never click pay again until checking original signature | “We're checking the receipt before any retry to avoid a second payment.” |
| Wrong mint/network/recipient | Reject immediately; no stage repair | “The request didn't match our devnet-only demo.” |

Fallback order: prepared config → known-good Explorer receipt → presenter-created recording → offline evidence table. There is no fabricated success screen or simulated balance substituted for settlement. After the demo, stop; no redeployment or added functionality.
