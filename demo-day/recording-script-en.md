# QazSplit — English pitch voiceover, under two minutes

Revised 2026-10-10. This replaces the previous four-minute script for the existing twelve-slide deck. The user supplied a two-minute pitch limit; this revision plans for 1:50, leaving ten seconds of margin. The event rule was not independently verified. No audio has been generated or measured; check the final exported video stays within the supplied limit, including all titles, pauses and transitions.

## AI voice instructions — not spoken

Use [narration-en.txt](narration-en.txt) for clean speech input. It contains twelve paragraphs, one per slide. Prefer a separate audio clip per slide, without narrating headings or timestamps.

Read in clear, natural English, calmly and confidently, at approximately 130 words per minute. Pronounce QazSplit as “Kaz Split” and USDC as the letters “U S D C.” Do not add an introduction, commentary, sound effects or extra claims. Use short sentence pauses. Numbers are already written as words.

## Per-slide script and planned holds

### Slide 1: Introduction — 8 seconds (0:00–0:08)

> One client payment. Every teammate paid. QazSplit splits project payments directly between approved wallets on Solana devnet.

### Slide 2: Problem — 9 seconds (0:08–0:17)

> A fifty, thirty, twenty split should not depend on one teammate receiving everything and manually paying everyone else.

### Slide 3: Audience — 7 seconds (0:17–0:24)

> We focus on teams of two to five people already using Solana wallets for projects.

### Slide 4: Workflow — 11 seconds (0:24–0:35)

> Propose, approve, pay, verify. Each recipient signs approval; each milestone payment needs one payer signature and transfers directly to recipients.

### Slide 5: Recipient approval — 12 seconds (0:35–0:47)

> Each recipient signs their share. Payments unlock only after everyone approves. Duplicate and unauthorized approvals fail. Addresses and shares stay fixed from proposal creation.

### Slide 6: Milestones — 10 seconds (0:47–0:57)

> Design, Development, Launch: separate milestones, one approved split. Clients pay each milestone once, with no escrow or reserved funds.

### Slide 7: Verified payment — 13 seconds (0:57–1:10)

> This confirmed devnet payment split twenty mock USDC into ten, six, and four. One payer signature, one atomic transaction: every transfer succeeds, or distribution rolls back.

### Slide 8: Receipt and history — 9 seconds (1:10–1:19)

> Receipts show exact payouts, addresses, timestamps, and an Explorer link. Wallet history lets teammates reopen and verify confirmed payments.

### Slide 9: Why Solana — 10 seconds (1:19–1:29)

> Solana enforces approved shares and milestone state onchain, with direct, atomic transfers. These checks do not depend solely on our interface.

### Slide 10: Differentiation — 8 seconds (1:29–1:37)

> Our focus is recipient consent, milestones, direct payouts, and receipts, rather than payment splitting alone.

### Slide 11: Verification and limits — 8 seconds (1:37–1:45)

> Recorded tests passed: twenty-six Anchor, one hundred and nine frontend. Unaudited; mock tokens only.

### Slide 12: Closing — 5 seconds (1:45–1:50)

> Try QazSplit on devnet. Agree, pay, verify. Thank you.

## Timing check and recording notes

- Twelve planned holds total 110 seconds. This is a production plan, not a measured speech duration.
- The script has approximately 217 written words; technical abbreviations/pronunciation may add spoken syllables and time.
- Generate the voice first, then fit each slide to its clip. Use a short silent hold if needed; do not add a long opening or closing sequence.
- If the result exceeds two minutes, shorten pauses or wording before increasing voice speed. Verify the final exported file duration.
- This narrates an existing confirmed devnet payment, not a fresh signing sequence. The approval transition is illustrative; the screenshot shows actual 3/3 status.
- Test counts describe recorded implementation verification, not a new run. No audit, demand or competitor-feature-exclusivity claim is made.
- Only narration files changed. No app, program, address, deployment or payment changes.

Create-pitch-deck guidance keeps one main point per slide, reserves more time for the product proof, and removes repeated caveats while retaining the devnet/mock-token and unaudited boundaries.
