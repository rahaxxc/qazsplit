import { afterEach, describe, expect, it, vi } from "vitest";

import { MultiHopperApiError, createMultiHopperClient, parseEstimate, parsePreparedTxs, parseTransfer } from "./api";
import { MULTIHOPPER_DEVNET_API_BASE_URL, MultiHopperConfigError, readMultiHopperConfig, redactSecrets } from "./config";

const apiKey = "mh_test_unit_k3y_never_logged";
const tx = Buffer.from(new Uint8Array(160).fill(7)).toString("base64");

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("MultiHopper server configuration", () => {
  it("refuses to run without an API key", () => {
    expect(() => readMultiHopperConfig({})).toThrow(MultiHopperConfigError);
    expect(() => readMultiHopperConfig({ MULTIHOPPER_API_KEY: "   " })).toThrow("MULTIHOPPER_API_KEY is not set.");
  });

  it("refuses mainnet or malformed keys and never echoes the value", () => {
    for (const key of ["mh_live_real_money", "sk_other_value"]) {
      try { readMultiHopperConfig({ MULTIHOPPER_API_KEY: key }); expect.unreachable(); }
      catch (error) { expect(error).toBeInstanceOf(MultiHopperConfigError); expect((error as Error).message).not.toContain(key); }
    }
    expect(() => readMultiHopperConfig({ MULTIHOPPER_API_KEY: "mh_test_" })).toThrow(MultiHopperConfigError); // prefix alone is not a key
  });

  it("uses a dedicated routing secret only when it is strong enough", () => {
    expect(readMultiHopperConfig({ MULTIHOPPER_API_KEY: apiKey })).toEqual({ apiKey, tokenSecret: apiKey });
    expect(readMultiHopperConfig({ MULTIHOPPER_API_KEY: apiKey, QAZSPLIT_ROUTING_SECRET: "s".repeat(32) }).tokenSecret).toBe("s".repeat(32));
    expect(() => readMultiHopperConfig({ MULTIHOPPER_API_KEY: apiKey, QAZSPLIT_ROUTING_SECRET: "short" })).toThrow(/32 characters/);
  });

  it("is pinned to the devnet API", () => {
    expect(MULTIHOPPER_DEVNET_API_BASE_URL).toBe("https://devnet.multihopper.com/api/v1");
  });

  it("redacts keys and routing tokens from text", () => {
    expect(redactSecrets(`bad ${apiKey} and mh_live_abc and qzr1.eyJ.sig`, apiKey)).toBe("bad [redacted] and [redacted] and [redacted]");
  });
});

describe("MultiHopper HTTP client", () => {
  it("sends documented headers to the devnet base URL, with Idempotency-Key on POST only", async () => {
    const fetchMock = vi.fn(async (url: string) => respond(200, url.endsWith("/estimate") ? { hopAmountRaw: "990000000" } : { id: 42, status: "quote" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createMultiHopperClient({ apiKey });
    await client.createTransfer({ tokenMint: "So11111111111111111111111111111111111111112", amountRaw: "1", amountTokens: "0.000000001", tokenDecimals: 9, tokenSymbol: "SOL",
      sourceOwner: "a", recipientWallet: "b", hops: 3, arrivalSeconds: 300, externalId: "qzs-x" }, "qzs-create-fixed");
    await client.getTransfer(42);
    const [createUrl, createInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [getUrl, getInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(createUrl).toBe("https://devnet.multihopper.com/api/v1/transfers");
    expect(createInit.method).toBe("POST");
    expect(createInit.redirect).toBe("error");
    expect(createInit.headers).toMatchObject({ "x-api-key": apiKey, "Idempotency-Key": "qzs-create-fixed", "Content-Type": "application/json" });
    expect(JSON.parse(createInit.body as string)).toMatchObject({ externalId: "qzs-x", tokenDecimals: 9 });
    expect(getUrl).toBe("https://devnet.multihopper.com/api/v1/transfers/42");
    expect(getInit.headers).not.toHaveProperty("Idempotency-Key");
    expect(getInit.body).toBeUndefined();
  });

  it("maps the documented error envelope and Retry-After, redacting secrets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(429, { error: { code: "MH_004", message: `slow down ${apiKey}`, requestId: "req-1" } }, { "retry-after": "12" })));
    const error = await createMultiHopperClient({ apiKey }).getTransfer(1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MultiHopperApiError);
    expect(error).toMatchObject({ status: 429, code: "MH_004", retryAfter: "12", upstreamRequestId: "req-1" });
    expect((error as Error).message).not.toContain(apiKey);
  });

  it("reports timeouts, network failures and non-JSON bodies distinctly", async () => {
    const client = createMultiHopperClient({ apiKey });
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }));
    await expect(client.getTransfer(1)).rejects.toMatchObject({ status: 504, code: "UPSTREAM_TIMEOUT" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(client.getTransfer(1)).rejects.toMatchObject({ status: 502, code: "UPSTREAM_UNAVAILABLE" });
    vi.stubGlobal("fetch", vi.fn(async () => respond(200, "<html>gateway</html>")));
    await expect(client.getTransfer(1)).rejects.toMatchObject({ status: 502, code: "UPSTREAM_INVALID_RESPONSE" });
    vi.stubGlobal("fetch", vi.fn(async () => respond(503, "unavailable")));
    await expect(client.getTransfer(1)).rejects.toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
  });
});

describe("MultiHopper response parsing", () => {
  it("accepts GET transfer both at top level and wrapped in { transfer }", () => {
    const body = { id: 42, status: "active", sourceOwner: "w", progress: { hopsCompleted: 2, hopsTotal: 3 }, signatures: { routeInit: ["a"], sessionInit: [], hops: ["h"] } };
    expect(parseTransfer(body)).toMatchObject({ id: 42, status: "active", progress: { hopsCompleted: 2, hopsTotal: 3 } });
    expect(parseTransfer({ transfer: body })).toMatchObject({ id: 42, sourceOwner: "w", signatures: { hops: ["h"] } });
    expect(() => parseTransfer({ status: "active" })).toThrow(MultiHopperApiError);
    expect(() => parseTransfer({ id: -1, status: "x" })).toThrow(/unexpected response/);
  });

  it("normalizes prepared bundles: { base64 } route entries, null groups skipped, resume flag", () => {
    const parsed = parsePreparedTxs({
      keeperFundingTx: tx, routeInitTxs: [{ base64: tx }], orchestratorInitTx: null, sessionInitTxs: [tx, tx], dispersionInitTxs: [],
      recentBlockhash: "BpFi8bTNRuLbUnrq7q1N1M", lastValidBlockHeight: 289043200, resume: { nothingToDo: false },
    });
    expect(parsed).toEqual({ keeperFundingTx: tx, routeInitTxs: [tx], orchestratorInitTx: null, sessionInitTxs: [tx, tx], dispersionInitTxs: [],
      recentBlockhash: "BpFi8bTNRuLbUnrq7q1N1M", lastValidBlockHeight: 289043200, nothingToDo: false });
    expect(parsePreparedTxs({ routeInitTxs: null, keeperFundingTx: null, resume: { nothingToDo: true } })).toMatchObject({ routeInitTxs: [], sessionInitTxs: [], nothingToDo: true });
  });

  it.each([
    ["non-base64 transaction", { keeperFundingTx: "not base64!" }],
    ["oversized transaction", { keeperFundingTx: "A".repeat(6000) }],
    ["route entry without base64", { routeInitTxs: [{ data: tx }] }],
    ["too many transactions", { sessionInitTxs: Array(33).fill(tx) }],
    ["non-object bundle", "AQAA"],
  ])("rejects a malformed bundle (%s)", (_, bundle) => {
    expect(() => parsePreparedTxs(bundle)).toThrow(MultiHopperApiError);
  });

  it("reads documented estimate fields and requires the delivered amount", () => {
    const estimate = parseEstimate({ tier: "tier_2", percentFeeBps: 50, percentFeeRaw: "4969527", totalFlatFeeLamports: 1125000, hopAmountRaw: "993905472",
      priceSource: "onchain_pool", isTestMode: true, sol: { requiredSolUpFrontLamports: 1048210313, minTransferAmountLamports: 2039280,
        refundableLamports: 16083280, netCostLamports: 1032127033, breakdown: { screeningFeeLamports: 0 } } });
    expect(estimate).toMatchObject({ hopAmountRaw: "993905472", requiredSolUpFrontLamports: 1048210313, minTransferAmountLamports: 2039280, screeningFeeLamports: 0 });
    expect(parseEstimate({ tokens: { netDeliveredRaw: "5" } }).hopAmountRaw).toBe("5");
    expect(() => parseEstimate({ tier: "tier_0" })).toThrow(MultiHopperApiError);
  });
});
