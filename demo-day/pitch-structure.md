# Twelve-slide pitch

Updated 2026-10-10. Open [the offline presentation](../pitch-deck-20261006-001200.html) or [PDF](pitch-deck.pdf). Arrow keys navigate; N toggles Russian speaker notes; browser Print saves a landscape PDF. Do not show notes on the projector. This is a Demo Day aid, not a submitted application or an eligibility claim. English slide copy and the existing dark green/teal design are retained.

| Slide | Headline | On-screen content | Speaker point |
|---|---|---|---|
| 1 | One client. Everyone paid. | Agree on shares; pay by milestone; verify payouts | Working devnet prototype, mock tokens only. |
| 2 | Who forwards the team's payment? | Hypothetical 50/30/20 team; manual forwarding | Problem hypothesis, not measured customer pain. |
| 3 | Small teams. Shared project income. | 2–5 teammates already using Solana wallets | Intended segment, not existing customers. Not banking, escrow or full payroll. |
| 4 | Agree first. Pay directly. | Propose → Approve → Pay → Verify | Proposal and approvals are separate transactions. One client signature per payment. |
| 5 | Nobody's share is assumed. | Illustrative 2/3 → 3/3 transition + actual approved UI | Onchain recipient signatures; no payments before all approve. Terms fixed from proposal. |
| 6 | One agreement. Separate project stages. | Design / Development / Launch | Same approved shares; pay each stage once. No delivery verification or escrow. |
| 7 | 20 in. 10 / 6 / 4 out. | Actual milestone selector + verified token deltas | Existing finalized payment, not a new signing recording; cannot repeat a Paid milestone. |
| 8 | A receipt the team can verify. | Actual receipt and wallet history screenshots | Exact allocations, timestamp and signature; no database; RPC retention limits apply. |
| 9 | Settlement, not a spreadsheet. | Agreement PDA → program → Token Program | Verifiable consent and direct atomic settlement; not exclusive to Solana. |
| 10 | An agreed project payment, not a treasury. | Fideox archive, Splitter vault README, SplitPact graphs | Workflow focus, not unsupported feature exclusivity or a proven moat. |
| 11 | Working proof. Honest limits. | Check/result table; recorded 26 Anchor / 109 frontend tests | Distinguish local failure-path tests from the finalized devnet payment. No audit/demand claim. |
| 12 | Help us test the workflow. | Try one devnet project payment; live URL | Ask for feedback on approval/payment friction. No fundraising or new feature commitment. |

## Added visuals and recording cues

Keep `demo-day/assets/` beside the HTML at its existing relative path. All four PNGs are actual QazSplit UI captures from `https://qazsplit.vercel.app` on 2026-10-10, using real devnet RPC data. No approval/payment transaction was signed or sent. For wallet-specific history/balance display, a read-only Wallet Standard bridge exposed only the existing public payer address and rejected every signing attempt; zero signing requests occurred. This is not a recording of Phantom or a fresh payment.

- Slide 4: connected Propose → Approve → Pay → Verify diagram; explicitly no vault.
- Slide 5: `assets/recipient-approval.png`, actual 3/3 state. The 2/3 → 3/3 diagram is labelled illustrative; no fake Pending screenshot.
- Slide 6: milestone/status table remains.
- Slide 7: `assets/milestone-payment.png`, existing Paid Development selection, with large verified +10/+6/+4 deltas. The wallet balance in the screenshot is a snapshot, not a live balance or a transfer delta.
- Slide 8: `assets/development-receipt.png` and `assets/wallet-history.png`. Receipt signature matches the finalized transaction linked below.
- Slide 10: evidence-qualified competitor comparison remains.
- Slide 11: compact checks/results table; test counts refer to the recorded implementation verification, not a new test run.

Для видеозаписи: открой HTML на весь экран, скрой заметки клавишей N, записывай голос отдельно или вместе с экраном. На слайде 4 проведи зрителя по четырём шагам; на 5 объясни, почему при 2/3 оплата закрыта; на 7 назови 20 → 10/6/4; на 8 покажи квитанцию и историю; на 11 кратко раздели проверенное и ограничения. Таблицы объясняй выводом, не читай каждую ячейку. Русские заметки на каждом слайде содержат подробности для озвучки.

Если хочешь вставить именно новую оплату и окно Phantom, запиши их отдельно на заранее подготовленном неоплаченном devnet-этапе: выбор этапа → симуляция → проверка devnet в Phantom → подпись → квитанция → Explorer. Существующий Development уже Paid; его нельзя оплатить ещё раз. Не выдавай сохранённые снимки за новую транзакцию. Этот набор содержит слайды и снимки, не готовый озвученный видеоролик.

Presentation checks passed in headless Edge: all 12 slides at 1920 / 1280 / 768 / 375 px, no clipping/overflow, four local screenshots decode successfully, keyboard/button navigation and notes toggle, visible keyboard focus, no JavaScript errors and no network dependencies. PDF regenerated with 12 pages and speaker notes excluded. App build/test suites were not rerun because no app/program files changed; the test counts on slide 11 remain explicitly historical results.

## Positioning to keep consistent

QazSplit is a devnet prototype for recipient-approved, fixed-percentage, milestone-based client-to-team token payments. It is not an escrow, recurring payroll scheduler, group-expense tracker, automatic listener for arbitrary incoming transfers, delivery-verification service, or treasury manager. Legacy SplitConfig URLs remain supported; new milestone proposals use SplitAgreement.

Every configured recipient approves their own share onchain before milestone payments unlock. Terms are immutable from proposal creation, even while Pending. This does not establish a legal agreement or prove delivery. The current devnet program is upgradeable: fixed agreement terms do not mean an immutable deployment.

## Honest readiness note

Technical demo evidence is strong for this bounded MVP. Market demand and defensibility remain unproven. Rehearse the actual extension wallet. The current UI can retain an RPC error banner next to an already successful payment receipt; confirm the transaction in Explorer and do not claim this deck revision fixed the app. No event time limit/rules were supplied, so suggested pacing is not an official requirement.

The old `demo-script.md` describes the legacy flow; do not reuse it unchanged for recipient approvals/milestones. The 12 updated slide notes cover the current flow. For a fresh live payment, prepare an actual unpaid milestone; do not retry the existing Paid Development milestone. Historical receipts must be labelled as historical.

## Evidence refreshed for this revision

Read-only devnet `getTransaction` on 2026-10-10, commitment finalized, maximum supported transaction version 1: signature `4XN2cKLQkooRBWoCuqJk4AjkHy4ia2PfqihPHaPzjXNpy4fRJg4wuqauemuG4MohiKnz4r2yoN2Hn2fHQTxfukmh`, slot 509571296, `meta.err = null`, one signature, timestamp 2026-10-10T14:30:23Z. Actual six-decimal mock-token deltas: payer −20, recipients +10 / +6 / +4. No transaction was signed or sent for deck preparation.

- [Actual Development receipt](https://explorer.solana.com/tx/4XN2cKLQkooRBWoCuqJk4AjkHy4ia2PfqihPHaPzjXNpy4fRJg4wuqauemuG4MohiKnz4r2yoN2Hn2fHQTxfukmh?cluster=devnet).
- [Recorded implementation and tests](../reports/history-devnet-verification.md): 26 Anchor and 109 frontend tests passed on 2026-10-10; not rerun for presentation-only changes.
- [Splitter README](https://github.com/mertizal/Web3-Splitter), reread 2026-10-10: vault deposit/update/claim workflow, not independently executed or audited.
- [SplitPact publisher site](https://splitpact.com/), reread 2026-10-10: business cashflow graphs and conditional deposit routing. Publisher claims, not audited behavior. Do not claim it lacks approvals, milestones or working payouts.
- Fideox's [public submission link](https://colosseum.com/projects/explore/fideox) remained inaccessible. Its treasury comparison refers only to the archive reviewed 2026-10-05 in [old evidence](evidence.md); current status unverified. Bounded exploit-name searches did not establish an incident, which is not proof of safety. No competitor metrics or market-size claims are added.
- [Solana transactions](https://solana.com/docs/core/transactions), reread 2026-10-10: atomic state execution; failed transactions may still charge fees. Other smart-contract chains also support atomicity.

## Editorial self-review and Q&A

Not an official judging score: technical evidence strong; completeness strong within devnet bounds; crypto necessity clear for verifiable consent/settlement; differentiation moderate and copyable; customer-demand evidence weak. Next validation step is team feedback, not invented traction.

- **Why not batch three transfers?** Batching also provides atomicity. QazSplit additionally enforces saved shares, recipient approvals and one-time milestone state.
- **Does Paid prove delivery?** No, only the milestone payment. Work acceptance stays offchain.
- **Can it handle real funds?** Not a readiness claim: unaudited, upgradeable devnet prototype and mock mint only.
- **Are there customers?** Not established. The ask is to try one devnet workflow and report confusing steps.

The create-pitch-deck skill guided narrative and evidence separation; design-taste/frontend guidelines retained the existing spacious, single-accent design. Video-craft guided actual UI close-ups and labelled historical proof rather than fabricated signing footage. Number formatting uses exact mock-token quantities and tabular numerals, not dollar values. App and contract code are untouched.
