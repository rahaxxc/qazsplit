# GitHub presentation preparation

Prepared October 11, 2026 (Asia/Qyzylorda). Documentation and presentation assets only; no application, program, dependency, address or authority changes. No deployment or transaction was submitted during preparation.

## Publication contents

- README updated to the current recipient-approved milestone workflow, with live app, narrated video, pitch, architecture and demo links.
- Architecture documentation distinguishes legacy `SplitConfig` from `SplitAgreement`, immutable terms from mutable approval/payment records, and fixed fields from the upgradeable devnet deployment.
- Development instructions include frontend workspace commands, pinned toolchain, local validator loading without a private deployment key, and public environment-variable boundaries.
- Demo guide distinguishes historical proof from a fresh payment, explains recipient wallet ownership and the exact mock mint, and includes timing and fallback instructions.
- Current twelve-slide HTML/PDF presentation, English pitch narration and four actual UI screenshots included.
- Finished English narrated MP4 included at `demo-day/QazSplit-demo-2m30-EN.mp4`, with its exact ten-scene narration JSON. The video is a read-only walkthrough, not a fresh signing session.
- Contribution guide and bounded roadmap added. Existing CI is retained unchanged. MIT license added following the maintainer's explicit approval in this task.

The source template was [Marakaya/colosseum_example](https://github.com/Marakaya/colosseum_example). Its organization inspired the README; its product claims, implementation and example team information were not copied. The project license was chosen explicitly, not inferred from the template. No event eligibility, official judging weights or submitted application status is claimed.

## Checks run during this preparation

| Check | Result |
|---|---|
| `npm run lint` | PASS |
| `npm test` | PASS: 109 tests across 10 files |
| `npm exec --workspace app -- tsc --noEmit` | PASS |
| `npm run build` | PASS: `/`, `/history`, `/pay/[split]` |
| `npm run verify:fixture` | PASS: existing six-decimal classic SPL mock mint on devnet |
| Local document links and assets | PASS: relative links/assets checked in current documents and deck source |
| Narration timeline | PASS: ten scene durations total 150 seconds |
| Live frontend routes | HTTP 200 for homepage, known agreement and history |
| Read-only devnet proof check | PASS: successful finalized Development transaction, one signature, exact −20/+10/+6/+4 mock-token deltas |
| Program account | Executable on devnet |

Anchor build/integration tests were **not rerun** for this documentation-only task. The 26 passing Anchor tests are the historical October 10 implementation results linked in the README, not a new test result. The clean-clone validator command flags were checked against the installed CLI help; this task did not rehearse a new clean-clone build.

## Media / transaction provenance

Video SHA-256:

```text
4c70dc2003074968d9e3610ab09ba650f1f48aadf6318b03f61a9c94c0de25d4
```

Final MP4 duration is 150 seconds, H.264 1600×900 at 25 fps with AAC audio. English speech uses local Microsoft Zira synthesis. Full audio/video decode and non-silent speech in all ten scenes were verified during the preceding rendering task; the same finished file is copied into this repository without re-encoding.

The historical Development payment rechecked for this documentation:

```text
4XN2cKLQkooRBWoCuqJk4AjkHy4ia2PfqihPHaPzjXNpy4fRJg4wuqauemuG4MohiKnz4r2yoN2Hn2fHQTxfukmh
```

Slot `509571296`, timestamp `2026-10-10T14:30:23Z`, finalized, `meta.err = null`. The live read-only check confirms the existing receipt; no new payment occurred.

Local `.superstack/` context, obsolete alternative recording scripts, voice synthesis intermediates, wallet material, environment files and build outputs are excluded from this publication. This remains an unaudited devnet/mock-token prototype. Colosseum-copilot and submit-to-hackathon guidance informed evidence-first organization and reproducible demo instructions, not a final application submission.
