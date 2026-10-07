import { readFile } from "node:fs/promises";

const fixtureUrl = new URL("../fixtures/devnet.mock-usdc.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
const response = await fetch("https://api.devnet.solana.com", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [fixture.mint, { encoding: "jsonParsed", commitment: "confirmed" }],
  }),
});

if (!response.ok) throw new Error(`Devnet RPC returned HTTP ${response.status}.`);
const payload = await response.json();
const account = payload.result?.value;
if (!account) throw new Error("Mock USDC fixture mint was not found on devnet.");
if (account.owner !== fixture.tokenProgram) throw new Error("Fixture is not owned by SPL Token.");
if (account.data?.parsed?.type !== "mint") throw new Error("Fixture account is not a mint.");
if (account.data.parsed.info.decimals !== fixture.decimals) {
  throw new Error(`Expected ${fixture.decimals} decimals.`);
}

console.log(`Verified ${fixture.name}: ${fixture.mint} (${fixture.decimals} decimals, devnet)`);

