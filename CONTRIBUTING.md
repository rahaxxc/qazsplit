# Contributing

QazSplit is a devnet/mock-token hackathon prototype. Start with the [README](README.md), [architecture](docs/architecture.md) and [development commands](docs/development.md).

## Issues

Include the page/flow, expected and observed behavior, browser/wallet versions, and reproducible steps. Public devnet transaction signatures can help diagnose payment issues. Do not include private keys, seed phrases, passwords, RPC secrets or unredacted personal screenshots.

If a payment appears to fail after signing, check its signature in Explorer before retrying. A refresh error is not evidence that an already confirmed payment failed.

## Pull requests

- Keep changes small and explain which issue they address.
- Preserve direct payer-to-recipient atomic transfers and legacy account compatibility.
- Do not change devnet addresses, authorities, deployment configuration or feature scope without maintainer agreement.
- Run frontend lint, tests, TypeScript and production build. For onchain changes, run Anchor build and the full local integration suite; include relevant failure-path coverage.
- State what was actually run and what was not. A successful build is not a security audit.
- Never commit wallet files, local environment files, secrets, generated ledgers, `node_modules` or `target` artifacts.

Maintainer: [@rahaxxc](https://github.com/rahaxxc). The project is distributed under the [MIT license](LICENSE); keep the copyright and license notice with copies or substantial portions of the software.
