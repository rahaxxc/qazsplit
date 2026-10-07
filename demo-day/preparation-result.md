# Demo Day preparation result

Only frontend `app/src/app/globals.css` was changed. Visual polish preserves the existing green/neutral palette, improves heading/readout sizes, softens shadows, separates percentage symbols from typed values, enlarges touch targets and respects reduced motion. Existing recipient balances remain visible on narrow screens. No component logic, wallet flow or data-formatting code was changed.

Program source, all non-CSS files in `app/src`, Anchor.toml and the existing frontend environment-file hashes match the pre-edit snapshot. The mock token fixture hash is also unchanged. No smart-contract change, devnet address change, dependency install, feature, signing, deployment or existing-document rewrite occurred.

## Checks run after visual changes

| Check | Result |
|---|---|
| `npm run lint` | Passed |
| `npm test` | 10 tests passed across 2 files |
| `npm run build` | Passed; static Create route and dynamic Pay route built |
| Production browser: Create + Pay, 1280 / 768 / 375 px | No horizontal overflow or page errors |
| Production browser: dark desktop Create + Pay | No horizontal overflow or page errors |
| Hydration: absent / installed / persisted test wallet, both routes and hard reloads | No hydration warnings; read-only mocked wallet, no signing |
| Offline HTML deck | 8 slides, 8 speaker notes, arrow navigation and N toggle pass; no external resource requests |
| Deck content checks | No slide overflow; bullets at most 6 words / 6 per slide |
| PDF export | 8 pages generated successfully |
| Spoken script length | 174 words; about 70 seconds at 150 wpm plus click/confirmation pauses; rehearse to stay below 90 seconds |
| Historical receipt recheck | Devnet RPC returned success, one signature, +5/+3/+2 recipient changes |
| Explorer fallback | Actual historical Success receipt captured as an offline screenshot |

Browser checks used Microsoft Edge with Playwright. Production frontend was started at [localhost](http://127.0.0.1:3000). The real extension-wallet live payment was not rerun during Demo Day preparation. A presenter-created rehearsal recording remains a recommended pre-event step, not a completed asset.

## Assets

- [Offline eight-slide HTML](../pitch-deck-20261006-001200.html) and [PDF](pitch-deck.pdf).
- [Eight-slide pitch structure](pitch-structure.md).
- [60–90 second demo script](demo-script.md).
- [Judge Q&A, Solana rationale and competitor comparison](judge-qa.md).
- [Demo checklist and fallback decision table](checklist.md).
- [Evidence and claim limits](evidence.md).
- [Historical Explorer screenshot](verified-devnet-receipt.png), not a new transaction result.

Ready as prepared Demo Day assets, not a claim of audited production readiness or validated demand. Stop here: no redeployment or new functionality.
