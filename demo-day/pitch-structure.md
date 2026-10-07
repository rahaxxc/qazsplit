# Eight-slide pitch

Open [the offline presentation](../pitch-deck-20261006-001200.html). Arrow keys navigate; N toggles private speaker notes; browser Print saves a landscape PDF. Do not show notes on the projector. The deck is a Demo Day aid, not a submitted application or a claim of eligibility for a particular cohort.

| Slide | Headline | On-screen content | Speaker point |
|---|---|---|---|
| 1 | One client. Everyone paid. | QazSplit · small-team payments · devnet prototype | State what it does in one sentence. No invented founder story. |
| 2 | Who forwards the team's payment? | Hypothetical 50/30/20 team; manual forwarding | Explain the coordination problem as a hypothesis, not measured customer pain. |
| 3 | Set once. Pay directly. | Create Split → Pay Split; no custody/escrow | Team setup and payer payment are distinct transactions. Two to five recipients; fixed configuration. |
| 4 | 10 in. 5 / 3 / 2 out. | Payment arithmetic and devnet receipt | Switch to the UI for the 60–90 second demo. Compare balance deltas, not absolute balances. |
| 5 | Settlement, not a spreadsheet. | SplitConfig PDA → program → Token Program | Solana enforces recorded allocation and atomic settlement. Other chains also support atomicity. |
| 6 | Narrower by design. | Fideox treasury; Splitter vaults; SplitPact graph routing; QazSplit direct payouts | A specific workflow wedge, not unique technology or a proven moat. See dated sources. |
| 7 | Working proof. Honest limits. | Verified devnet receipt; local failure-path tests; test-only scope | Technical proof is not customer traction. No claim of audit, real-USDC support, or production readiness. |
| 8 | Help us test the workflow. | Feedback from Solana-paid teams | Proposed next step: test whether teams prefer this workflow. No new feature/deployment commitment. |

## Positioning to keep consistent

QazSplit is a devnet prototype for direct, fixed-percentage client-to-team token payments. It is not an escrow, recurring payroll scheduler, group-expense tracker, automatic listener for arbitrary incoming transfers, or treasury manager.

The team records a proposed/pre-agreed allocation; the software does not collect recipient consent or legally establish an agreement. “Immutable” describes SplitConfig under the current program, not an immutable deployment: the devnet program is upgradeable.

## Honest readiness note

Technical demo evidence is strong for this bounded MVP. Market demand and defensibility remain unproven. The main Demo Day risk is wallet/RPC/confirmation timing; rehearse the actual extension wallet rather than assuming the prior automated wallet bridge proves extension compatibility. No official judging rubric or event rules were provided, so this is not an official judge score or eligibility assessment.
