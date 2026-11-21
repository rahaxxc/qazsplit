import { generateKeyPair, getAddressFromPublicKey, getBase58Decoder, signBytes } from "@solana/kit";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ context: vi.fn() }));
// The onchain recipient/Paid check has its own RPC-level tests; here it is controlled directly.
vi.mock("@/lib/multihopper/server/context", async (original) => ({
  ...await original<typeof import("@/lib/multihopper/server/context")>(), assertRecipientOfPaidMilestone: state.context,
}));

import { issueAccessToken, verifyAccessToken } from "@/lib/multihopper/server/auth";
import { resetRateLimits } from "@/lib/multihopper/server/guards";
import { RoutingContextError } from "@/lib/multihopper/server/context";
import { SOL_MINT, buildRecoveryMessage, buildRoutingApprovalMessage, type RecoveryRequest, type RoutingRequest } from "@/lib/multihopper/shared";
import { POST as estimateRoute } from "./estimate/route";
import { GET as statusRoute } from "./transfers/[transferId]/route";
import { POST as confirmRoute } from "./transfers/[transferId]/confirm-broadcast/route";
import { POST as prepareRoute } from "./transfers/[transferId]/prepare/route";
import { POST as recoveryRoute } from "./transfers/[transferId]/recovery/route";
import { POST as recoverRoute } from "./transfers/recover/route";
import { POST as createRoute } from "./transfers/route";

const apiKey = "mh_test_route_suite_secret_value";
const agreement = "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq";
const destination = "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8";
const otherWallet = "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ";
const tx = Buffer.from(new Uint8Array(160).fill(9)).toString("base64");
const sig = (n: number) => getBase58Decoder().decode(new Uint8Array(64).fill(n));
let wallet: string;
let privateKey: CryptoKey;

type UpstreamCall = { method: string; path: string; headers: Record<string, string>; body: unknown };
let calls: UpstreamCall[];
let upstream: Record<string, (call: UpstreamCall) => Response | Promise<Response>>;

const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mhError = (status: number, code: string, message = code) => respond(status, { error: { code, message, requestId: "upstream-req" } });
const transfer = (overrides: Record<string, unknown> = {}) => ({
  id: 42, externalId: "qzs-placeholder", supportBundleId: "MH-qazsplit-42", tokenMint: SOL_MINT, amountRaw: "250000000", amountTokens: "0.25",
  sourceOwner: wallet, recipientWallet: destination, recipientReceivesRaw: "248500000", status: "quote", hops: 3, arrivalSeconds: 300,
  percentFeeBps: 50, percentFeeRaw: "1242500", totalFlatFeeLamports: 0, isTest: true, ...overrides,
});
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`http://localhost/api/multihopper${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
});
const params = (transferId: string) => ({ params: Promise.resolve({ transferId }) });
const bearer = async (transferId = 42, owner = wallet) => ({ authorization: `Bearer ${await issueAccessToken(apiKey, { transferId, wallet: owner, agreement, milestoneIndex: 0 })}` });
const body = async (response: Response) => response.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signedRequest(overrides: Partial<RoutingRequest> = {}, signOverrides: Partial<RoutingRequest> = {}) {
  const request: RoutingRequest = {
    wallet, agreement, milestoneIndex: 0, amountLamports: "250000000", destination, hops: 3, arrivalSeconds: 300,
    requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), origin: "http://localhost", ...overrides,
  };
  const message = buildRoutingApprovalMessage({ ...request, ...signOverrides });
  return { ...request, signature: getBase58Decoder().decode(await signBytes(privateKey, new TextEncoder().encode(message))) };
}

beforeAll(async () => {
  const keyPair = await generateKeyPair();
  privateKey = keyPair.privateKey;
  wallet = await getAddressFromPublicKey(keyPair.publicKey);
});

beforeEach(() => {
  vi.stubEnv("MULTIHOPPER_API_KEY", apiKey);
  vi.stubEnv("QAZSPLIT_ROUTING_SECRET", "");
  state.context.mockReset().mockResolvedValue(undefined);
  resetRateLimits();
  calls = [];
  upstream = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const call = {
      method: init.method ?? "GET", path: url.replace("https://devnet.multihopper.com/api/v1", ""),
      headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const handler = upstream[`${call.method} ${call.path}`];
    if (!handler) throw new Error(`unexpected upstream call ${call.method} ${call.path}`);
    return handler(call);
  }));
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("missing MultiHopper API key", () => {
  it.each(["", "mh_live_mainnet_key"])("every route answers 503 without calling MultiHopper (key=%j)", async (key) => {
    vi.stubEnv("MULTIHOPPER_API_KEY", key);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const responses = await Promise.all([
      estimateRoute(post("/estimate", { amountLamports: "1000", hops: 3, arrivalSeconds: 300 })),
      createRoute(post("/transfers", await signedRequest())),
      prepareRoute(post("/transfers/42/prepare", {}), params("42")),
      confirmRoute(post("/transfers/42/confirm-broadcast", { routeInitSignatures: [] }), params("42")),
      statusRoute(new Request("http://localhost/api/multihopper/transfers/42"), params("42")),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect((await body(response)).error.code).toBe("MULTIHOPPER_NOT_CONFIGURED");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("estimate", () => {
  it.each([["0"], ["-1"], ["abc"], [1.5], [undefined], ["100000000001"]])("rejects invalid amount %j before calling MultiHopper", async (amountLamports) => {
    const response = await estimateRoute(post("/estimate", { amountLamports, hops: 3, arrivalSeconds: 300 }));
    expect(response.status).toBe(400);
    expect((await body(response)).error.code).toBe("INVALID_REQUEST");
    expect(calls).toHaveLength(0);
  });

  it("rejects non-JSON bodies and out-of-range hops", async () => {
    expect((await estimateRoute(post("/estimate", "amount=1", { "content-type": "text/plain" }))).status).toBe(415);
    expect((await estimateRoute(post("/estimate", "{not json"))).status).toBe(400);
    expect((await estimateRoute(post("/estimate", { amountLamports: "1000", hops: 11, arrivalSeconds: 300 }))).status).toBe(400);
  });

  it("quotes SOL on devnet with the documented request body and returns only sanitized fields", async () => {
    upstream["POST /transfers/estimate"] = () => respond(200, { tier: "tier_0", percentFeeBps: 50, percentFeeRaw: "1242500", totalFlatFeeLamports: 0,
      hopAmountRaw: "248757500", priceSource: "onchain_pool", isTestMode: true, internalOnly: "x",
      sol: { requiredSolUpFrontLamports: 290000000, minTransferAmountLamports: 2039280, refundableLamports: 16000000, netCostLamports: 274000000, breakdown: {} } });
    const response = await estimateRoute(post("/estimate", { amountLamports: "250000000", hops: 3, arrivalSeconds: 300 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { estimate } = await body(response);
    expect(estimate).toMatchObject({ hopAmountRaw: "248757500", requiredSolUpFrontLamports: 290000000, isTestMode: true });
    expect(estimate).not.toHaveProperty("internalOnly");
    expect(calls[0].body).toEqual({ tokenMint: SOL_MINT, amountRaw: "250000000", tokenDecimals: 9, hops: 3, arrivalSeconds: 300 });
    expect(calls[0].headers["x-api-key"]).toBe(apiKey);
  });

  it("passes MultiHopper validation errors through with their MH code", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    upstream["POST /transfers/estimate"] = () => mhError(400, "MH_012", "Amount below minimum");
    const response = await estimateRoute(post("/estimate", { amountLamports: "1000", hops: 3, arrivalSeconds: 300 }));
    expect(response.status).toBe(400);
    expect((await body(response)).error).toEqual({ code: "MH_012", message: "Amount below minimum" });
  });
});

describe("create transfer", () => {
  it.each([
    ["an invalid address", { destination: "not-a-wallet" }],
    ["the source wallet itself", { destination: "" }],
    ["the system program", { destination: "11111111111111111111111111111111" }],
  ])("rejects a destination that is %s", async (_, overrides) => {
    const request = await signedRequest(overrides.destination === "" ? { destination: wallet } : overrides);
    const response = await createRoute(post("/transfers", request));
    expect(response.status).toBe(400);
    expect((await body(response)).error.code).toBe("INVALID_REQUEST");
    expect(state.context).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([["0"], ["1.5"], ["100000000001"], [250000000]])("rejects invalid amount %j", async (amountLamports) => {
    // Signed over a valid amount; the submitted amount is what validation must reject.
    const response = await createRoute(post("/transfers", { ...(await signedRequest()), amountLamports }));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a signature over different parameters, an expired approval and a missing signature", async () => {
    const tampered = await signedRequest({}, { destination: agreement }); // signed one destination, submitted another
    expect(await body(await createRoute(post("/transfers", tampered)))).toMatchObject({ error: { code: "INVALID_SIGNATURE" } });
    const stale = await signedRequest({ issuedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect(await body(await createRoute(post("/transfers", stale)))).toMatchObject({ error: { code: "APPROVAL_EXPIRED" } });
    const { signature: _unused, ...unsigned } = await signedRequest(); void _unused;
    expect((await createRoute(post("/transfers", unsigned))).status).toBe(401);
    expect(state.context).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["NOT_A_RECIPIENT", 403], ["MILESTONE_NOT_PAID", 409], ["AGREEMENT_NOT_FOUND", 404], ["RPC_UNAVAILABLE", 502],
  ] as const)("refuses %s from the onchain settlement check without creating anything", async (code, status) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.context.mockRejectedValue(new RoutingContextError(code, "rejected"));
    const response = await createRoute(post("/transfers", await signedRequest()));
    expect(response.status).toBe(status);
    expect((await body(response)).error.code).toBe(code);
    expect(calls).toHaveLength(0);
  });

  it("creates a quote with a request-bound externalId, a random Idempotency-Key and a transfer-bound token", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const request = await signedRequest();
    upstream["POST /transfers"] = () => respond(200, transfer({ externalId: `qzs-${request.requestId}` }));
    const response = await createRoute(post("/transfers", request));
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result.transfer).toMatchObject({ id: 42, status: "quote", supportBundleId: "MH-qazsplit-42", recipientReceivesLamports: "248500000" });
    expect(result.accessToken).toMatch(/^qzr1\./);
    expect(result.reused).toBe(false);
    // Random per attempt (audit M8): a cached upstream error is never replayed to a retry.
    expect(calls[0].headers["Idempotency-Key"]).toMatch(/^qzs-create-[0-9a-f-]{36}$/);
    expect(calls[0].headers["Idempotency-Key"]).not.toContain(request.requestId);
    expect(calls[0].body).toEqual({ tokenMint: SOL_MINT, amountRaw: "250000000", amountTokens: "0.25", tokenDecimals: 9, tokenSymbol: "SOL",
      sourceOwner: wallet, recipientWallet: destination, hops: 3, arrivalSeconds: 300, externalId: `qzs-${request.requestId}` });
    expect(state.context).toHaveBeenCalledWith(expect.objectContaining({ wallet, agreement, milestoneIndex: 0 }));
  });

  it("returns the original transfer for a duplicate request instead of creating a second one", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const request = await signedRequest();
    const externalId = `qzs-${request.requestId}`;
    let created = 0;
    upstream["POST /transfers"] = () => (created++ === 0 ? respond(200, transfer({ externalId })) : mhError(409, "MH_033", `Transfer already exists for externalId '${externalId}'`));
    upstream[`GET /transfers/by-external/${externalId}`] = () => respond(200, transfer({ externalId, status: "awaiting_signature" }));
    const first = await body(await createRoute(post("/transfers", request)));
    const second = await body(await createRoute(post("/transfers", request)));
    expect(first.transfer.id).toBe(42);
    expect(second).toMatchObject({ reused: true, transfer: { id: 42, status: "awaiting_signature" } });
    const creates = calls.filter((call) => call.path === "/transfers");
    expect(creates).toHaveLength(2);
    expect(new Set(creates.map((call) => call.headers["Idempotency-Key"])).size).toBe(2); // fresh key per attempt; externalId dedupes
    expect(new Set(creates.map((call) => (call.body as { externalId: string }).externalId))).toEqual(new Set([externalId]));
  });

  it("refuses to hand out access to a duplicate that belongs to someone else", async () => {
    const request = await signedRequest();
    upstream["POST /transfers"] = () => mhError(409, "MH_033");
    upstream[`GET /transfers/by-external/qzs-${request.requestId}`] = () => respond(200, transfer({ sourceOwner: otherWallet }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await createRoute(post("/transfers", request));
    expect(response.status).toBe(409);
    const result = await body(response);
    expect(result.error.code).toBe("TRANSFER_MISMATCH");
    expect(result).not.toHaveProperty("accessToken");
  });

  it.each([
    [400, "MH_014", 400, "MH_014"],
    [401, "MH_001", 503, "MH_001"], // our server key, not the user's credentials
    [409, "MH_072", 409, "MH_072"],
    [500, "MH_090", 502, "MH_090"],
  ])("maps upstream HTTP %i %s to %i", async (upstreamStatus, code, status, expectedCode) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    upstream["POST /transfers"] = () => mhError(upstreamStatus, code);
    const response = await createRoute(post("/transfers", await signedRequest()));
    expect(response.status).toBe(status);
    expect((await body(response)).error.code).toBe(expectedCode);
  });
});

describe("prepare transfer", () => {
  it("requires an access token for exactly this transfer", async () => {
    expect((await prepareRoute(post("/transfers/42/prepare", {}), params("42"))).status).toBe(401);
    expect((await prepareRoute(post("/transfers/42/prepare", {}, await bearer(43)), params("42"))).status).toBe(401);
    expect((await prepareRoute(post("/transfers/42/prepare", {}, { authorization: "Bearer qzr1.forged.token" }), params("42"))).status).toBe(401);
    expect((await prepareRoute(post("/transfers/4x/prepare", {}, await bearer()), params("4x"))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("returns the normalized bundle and uses a fresh Idempotency-Key per call", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    upstream["POST /transfers/42/prepare"] = () => respond(200, { transfer: { id: 42, status: "awaiting_signature", sourceOwner: wallet },
      preparedTxs: { keeperFundingTx: tx, routeInitTxs: [{ base64: tx }], orchestratorInitTx: tx, sessionInitTxs: [tx], dispersionInitTxs: [],
        recentBlockhash: "BpFi8bTNRuLbUnrq7q1N1M", lastValidBlockHeight: 289043200, resume: { nothingToDo: false } } });
    const headers = await bearer();
    const first = await body(await prepareRoute(post("/transfers/42/prepare", {}, headers), params("42")));
    await prepareRoute(post("/transfers/42/prepare", {}, headers), params("42"));
    expect(first.preparedTxs).toEqual({ keeperFundingTx: tx, routeInitTxs: [tx], orchestratorInitTx: tx, sessionInitTxs: [tx], dispersionInitTxs: [],
      recentBlockhash: "BpFi8bTNRuLbUnrq7q1N1M", lastValidBlockHeight: 289043200, nothingToDo: false });
    const keys = calls.map((call) => call.headers["Idempotency-Key"]);
    expect(keys[0]).toMatch(/^qzs-prepare-/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it.each([
    ["a stale quote (MH_040)", () => mhError(409, "MH_040", "Tier shifted"), 409, "MH_040"],
    ["a finished transfer (MH_035)", () => mhError(409, "MH_035"), 409, "MH_035"],
    ["an expired transfer (MH_034)", () => mhError(410, "MH_034"), 410, "MH_034"],
    ["a malformed bundle", () => respond(200, { transfer: { id: 42, status: "quote" }, preparedTxs: { keeperFundingTx: "%%%" } }), 502, "UPSTREAM_INVALID_RESPONSE"],
    ["an unreachable API", () => { throw new TypeError("fetch failed"); }, 502, "UPSTREAM_UNAVAILABLE"],
  ])("reports failed preparation: %s", async (_, handler, status, code) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    upstream["POST /transfers/42/prepare"] = handler;
    const response = await prepareRoute(post("/transfers/42/prepare", {}, await bearer()), params("42"));
    expect(response.status).toBe(status);
    expect((await body(response)).error.code).toBe(code);
  });

  it("never returns a bundle for a transfer owned by another wallet", async () => {
    upstream["POST /transfers/42/prepare"] = () => respond(200, { transfer: { id: 42, status: "quote", sourceOwner: otherWallet }, preparedTxs: { keeperFundingTx: tx } });
    const response = await prepareRoute(post("/transfers/42/prepare", {}, await bearer()), params("42"));
    expect(response.status).toBe(404);
    expect(await body(response)).not.toHaveProperty("preparedTxs");
  });
});

describe("confirm broadcast", () => {
  it("forwards exactly the documented keeper-funding-only body", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    upstream["POST /transfers/42/confirm-broadcast"] = () => respond(200, { transfer: { id: 42, status: "awaiting_signature" } });
    const response = await confirmRoute(post("/transfers/42/confirm-broadcast", { routeInitSignatures: [], keeperFundingSignature: sig(1), unexpected: "dropped" }, await bearer()), params("42"));
    expect(response.status).toBe(200);
    expect(calls[0].body).toEqual({ routeInitSignatures: [], keeperFundingSignature: sig(1) });
    expect(calls[0].headers["Idempotency-Key"]).toMatch(/^qzs-confirm-/);
  });

  it("forwards the final body and returns the processing transfer", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    upstream["POST /transfers/42/confirm-broadcast"] = () => respond(200, { transfer: { id: 42, status: "processing" } });
    const final = { routeInitSignatures: [sig(2)], orchestratorInitSignature: sig(3), sessionInitSignatures: [sig(4), sig(5)], keeperFundingSignature: sig(1) };
    const result = await body(await confirmRoute(post("/transfers/42/confirm-broadcast", final, await bearer()), params("42")));
    expect(calls[0].body).toEqual(final);
    expect(result.transfer.status).toBe("processing");
  });

  it.each([
    ["missing routeInitSignatures", { keeperFundingSignature: sig(1) }],
    ["a non-base58 signature", { routeInitSignatures: ["0OIl"] }],
    ["a wrong-length signature", { routeInitSignatures: [], keeperFundingSignature: getBase58Decoder().decode(new Uint8Array(32).fill(1)) }],
    ["a non-list session group", { routeInitSignatures: [], sessionInitSignatures: sig(4) }],
  ])("rejects %s before contacting MultiHopper", async (_, payload) => {
    const response = await confirmRoute(post("/transfers/42/confirm-broadcast", payload, await bearer()), params("42"));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [404, "MH_036"], // signature not found onchain
    [422, "MH_037"], // broadcast transaction failed onchain
    [422, "MH_038"], // did not invoke MultiHopper
    [400, "MH_039"], // keeper funding signature required
    [409, "MH_041"], // multi-destination binding not on chain
  ])("reports failed broadcast confirmation %i %s", async (status, code) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    upstream["POST /transfers/42/confirm-broadcast"] = () => mhError(status, code);
    const response = await confirmRoute(post("/transfers/42/confirm-broadcast", { routeInitSignatures: [sig(2)] }, await bearer()), params("42"));
    expect(response.status).toBe(status);
    expect((await body(response)).error.code).toBe(code);
  });
});

describe("transfer status", () => {
  const getStatus = async (headers: Record<string, string>) => statusRoute(new Request("http://localhost/api/multihopper/transfers/42", { headers }), params("42"));

  it("returns sanitized status, phase, progress and the real support reference to the owner", async () => {
    upstream["GET /transfers/42"] = () => respond(200, transfer({ externalId: "qzs-a", status: "active", phase: "executing", progress: { hopsCompleted: 1, hopsTotal: 3 },
      signatures: { routeInit: [sig(2)], sessionInit: [], hops: [sig(7)] }, lastError: null, recovery: { canRescue: false } }));
    const response = await getStatus(await bearer());
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result.transfer).toMatchObject({ id: 42, status: "active", phase: "executing", progress: { hopsCompleted: 1, hopsTotal: 3 },
      supportBundleId: "MH-qazsplit-42", hopSignatures: [sig(7)] });
    expect(result.transfer.recovery).toEqual({ canRescue: false, rescuableLamports: null, canReclaimRent: false, reclaimableLamports: null });
    expect(result.transfer.routeInitSignatures).toEqual([sig(2)]);
    expect(result.transfer).not.toHaveProperty("sourceOwner");
  });

  it("accepts the wrapped { transfer } response shape too", async () => {
    upstream["GET /transfers/42"] = () => respond(200, { transfer: transfer({ status: "completed", completedAt: "2026-11-15T10:00:00.000Z" }) });
    expect((await body(await getStatus(await bearer()))).transfer).toMatchObject({ status: "completed", completedAt: "2026-11-15T10:00:00.000Z" });
  });

  it.each([
    ["another wallet's transfer", transfer({ sourceOwner: otherWallet })],
    ["a transfer not created by QazSplit", transfer({ externalId: "someone-else-1" })],
  ])("hides %s", async (_, upstreamTransfer) => {
    upstream["GET /transfers/42"] = () => respond(200, upstreamTransfer);
    const response = await getStatus(await bearer());
    expect(response.status).toBe(404);
    expect((await body(response)).error.code).toBe("TRANSFER_NOT_FOUND");
  });

  it("requires a valid token and passes MH_030 through", async () => {
    expect((await getStatus({})).status).toBe(401);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    upstream["GET /transfers/42"] = () => mhError(404, "MH_030", "Transfer not found");
    expect((await body(await getStatus(await bearer()))).error.code).toBe("MH_030");
  });
});

describe("safe logging", () => {
  it("never logs the API key, access tokens, signatures or wallet addresses", async () => {
    const lines: string[] = [];
    for (const level of ["info", "warn", "error", "log"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    const request = await signedRequest();
    const headers = await bearer();
    upstream["POST /transfers"] = () => respond(200, transfer({ externalId: `qzs-${request.requestId}` }));
    upstream["POST /transfers/42/prepare"] = () => mhError(409, "MH_040", `tier moved for ${apiKey}`);
    upstream["POST /transfers/42/confirm-broadcast"] = () => mhError(500, "MH_090");
    upstream["GET /transfers/42"] = () => { throw new TypeError("fetch failed"); };
    await createRoute(post("/transfers", request));
    await prepareRoute(post("/transfers/42/prepare", {}, headers), params("42"));
    await confirmRoute(post("/transfers/42/confirm-broadcast", { routeInitSignatures: [sig(2)] }, headers), params("42"));
    await statusRoute(new Request("http://localhost/api/multihopper/transfers/42", { headers }), params("42"));
    vi.stubEnv("MULTIHOPPER_API_KEY", "");
    await estimateRoute(post("/estimate", { amountLamports: "1000", hops: 3, arrivalSeconds: 300 }));
    expect(lines.length).toBeGreaterThan(3);
    const output = lines.join("\n");
    for (const secret of [apiKey, headers.authorization.slice(7), request.signature, wallet, destination, sig(2)]) expect(output).not.toContain(secret);
  });
});

describe("origin binding (audit M5)", () => {
  it("refuses an approval signed for another site, or sent from one, before any check or upstream call", async () => {
    const lookalike = await signedRequest({ origin: "https://qazsplit-lookalike.example" });
    const response = await createRoute(post("/transfers", lookalike));
    expect(response.status).toBe(403);
    expect((await body(response)).error.code).toBe("ORIGIN_MISMATCH");
    const crossSite = await createRoute(post("/transfers", await signedRequest(), { origin: "https://evil.example" }));
    expect((await body(crossSite)).error.code).toBe("ORIGIN_MISMATCH");
    expect(state.context).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("uses QAZSPLIT_PUBLIC_ORIGIN when the deployment sits behind a proxy", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("QAZSPLIT_PUBLIC_ORIGIN", "https://qazsplit.example");
    const request = await signedRequest({ origin: "https://qazsplit.example" });
    upstream["POST /transfers"] = () => respond(200, transfer({ externalId: `qzs-${request.requestId}` }));
    expect((await createRoute(post("/transfers", request, { origin: "https://qazsplit.example" }))).status).toBe(200);
    expect((await body(await createRoute(post("/transfers", await signedRequest())))).error.code).toBe("ORIGIN_MISMATCH");
  });
});

describe("rate limiting (audit M4)", () => {
  it("limits anonymous estimates per client with Retry-After, before calling MultiHopper", async () => {
    upstream["POST /transfers/estimate"] = () => respond(200, { hopAmountRaw: "1", sol: {} });
    const client = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 10; i++) expect((await estimateRoute(post("/estimate", { amountLamports: "1000", hops: 3, arrivalSeconds: 300 }, client))).status).toBe(200);
    const limited = await estimateRoute(post("/estimate", { amountLamports: "1000", hops: 3, arrivalSeconds: 300 }, client));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await body(limited)).error.code).toBe("RATE_LIMITED");
    expect(calls).toHaveLength(10);
    // Another client still has budget, until the instance-wide cap protecting the shared key is reached.
    expect((await estimateRoute(post("/estimate", { amountLamports: "1000", hops: 3, arrivalSeconds: 300 }, { "x-forwarded-for": "198.51.100.2" }))).status).toBe(200);
  });

  it("keeps the instance under MultiHopper's per-key create limit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    upstream["POST /transfers"] = () => mhError(400, "MH_014");
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await createRoute(post("/transfers", await signedRequest(), { "x-forwarded-for": `192.0.2.${i}` }))).status);
    expect(statuses.slice(0, 8).every((status) => status === 400)).toBe(true);
    expect(statuses[8]).toBe(429);
    expect(calls).toHaveLength(8);
  });
});

describe("restoring routing access (audit H3)", () => {
  async function signedRecovery(overrides: Partial<RecoveryRequest> = {}) {
    const request: RecoveryRequest = { wallet, requestId: crypto.randomUUID(), issuedAt: new Date().toISOString(), origin: "http://localhost", ...overrides };
    const signature = getBase58Decoder().decode(await signBytes(privateKey, new TextEncoder().encode(buildRecoveryMessage(request))));
    return { ...request, signature };
  }

  it("issues tokens only for this wallet's QazSplit transfers, after a valid recovery signature", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let listed = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const path = String(url).replace("https://devnet.multihopper.com/api/v1", "");
      calls.push({ method: init?.method ?? "GET", path, headers: init?.headers as Record<string, string>, body: undefined });
      expect(path).toMatch(/^\/transfers\?limit=100&offset=0&fromDate=/);
      listed++;
      return respond(200, { items: [
        transfer({ id: 7, externalId: "qzs-a", status: "awaiting_signature" }),
        transfer({ id: 8, externalId: "qzs-b", sourceOwner: otherWallet }),
        transfer({ id: 9, externalId: "other-integration" }),
        transfer({ id: 10, externalId: "qzs-c", status: "completed" }),
      ], pagination: { total: 4, limit: 100, offset: 0 } });
    });
    const response = await recoverRoute(post("/transfers/recover", await signedRecovery()));
    expect(response.status).toBe(200);
    const { routings } = await body(response);
    expect(routings.map((routing: { transfer: { id: number } }) => routing.transfer.id)).toEqual([7, 10]);
    expect(listed).toBe(1);
    const claims = await verifyAccessToken(apiKey, routings[0].accessToken);
    expect(claims).toMatchObject({ transferId: 7, wallet, agreement: "", milestoneIndex: -1 });
  });

  it("refuses forged, stale or foreign-site recovery approvals without listing anything", async () => {
    const forged = { ...(await signedRecovery()), wallet: otherWallet };
    expect((await body(await recoverRoute(post("/transfers/recover", forged)))).error.code).toBe("INVALID_SIGNATURE");
    const stale = await signedRecovery({ issuedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect((await body(await recoverRoute(post("/transfers/recover", stale)))).error.code).toBe("APPROVAL_EXPIRED");
    const foreign = await signedRecovery({ origin: "https://evil.example" });
    expect((await body(await recoverRoute(post("/transfers/recover", foreign)))).error.code).toBe("ORIGIN_MISMATCH");
    expect(calls).toHaveLength(0);
  });
});

describe("rescue and rent reclaim (audit H3)", () => {
  const recoveryCall = async (payload: unknown, headers?: Record<string, string>) =>
    recoveryRoute(post("/transfers/42/recovery", payload, headers ?? await bearer()), params("42"));

  it("prepares a rescue only when MultiHopper reports canRescue, with a fresh Idempotency-Key", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    upstream["GET /transfers/42"] = () => respond(200, transfer({ externalId: "qzs-a", status: "failed", recovery: { canRescue: true, rescuableLamports: 5_000_000 } }));
    upstream["POST /transfers/42/rescue/prepare"] = () => respond(200, {
      rescueTxs: [{ base64: tx, partialSigners: ["keeper"] }], recentBlockhash: "BpFi8bTNRuLbUnrq7q1N1M", lastValidBlockHeight: 99, rescuable: { totalLamports: 5_000_000, accounts: [] },
    });
    const result = await body(await recoveryCall({ kind: "rescue", step: "prepare" }));
    expect(result.recoveryTxs).toEqual({ transactions: [tx], recentBlockhash: "BpFi8bTNRuLbUnrq7q1N1M", lastValidBlockHeight: 99, totalLamports: 5_000_000 });
    expect(calls.find((call) => call.path.endsWith("/rescue/prepare"))?.headers["Idempotency-Key"]).toMatch(/^qzs-rescue-prepare-/);
  });

  it("refuses to prepare when nothing is rescuable, and requires the transfer's token", async () => {
    upstream["GET /transfers/42"] = () => respond(200, transfer({ externalId: "qzs-a", status: "failed", recovery: { canRescue: false } }));
    const response = await recoveryCall({ kind: "rescue", step: "prepare" });
    expect(response.status).toBe(409);
    expect((await body(response)).error.code).toBe("RECOVERY_NOT_AVAILABLE");
    expect(calls.some((call) => call.path.includes("/rescue/"))).toBe(false);
    expect((await recoveryCall({ kind: "rescue", step: "prepare" }, await bearer(43))).status).toBe(401);
  });

  it("confirms with the documented body for each kind and validates signatures", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    upstream["GET /transfers/42"] = () => respond(200, transfer({ externalId: "qzs-a", status: "completed", recovery: { canReclaimRent: true } }));
    upstream["POST /transfers/42/reclaim-rent/confirm"] = () => respond(200, { confirmed: [sig(5)], failed: [] });
    upstream["POST /transfers/42/rescue/confirm"] = () => respond(200, { transfer: transfer({ externalId: "qzs-a", status: "refunded" }) });
    const reclaim = await body(await recoveryCall({ kind: "reclaim-rent", step: "confirm", signatures: [sig(5)] }));
    expect(reclaim.confirmed).toEqual([sig(5)]);
    expect(calls.find((call) => call.path.endsWith("/reclaim-rent/confirm"))?.body).toEqual({ reclaimSignatures: [sig(5)] });
    const rescue = await body(await recoveryCall({ kind: "rescue", step: "confirm", signatures: [sig(6)] }));
    expect(rescue.transfer.status).toBe("refunded");
    expect(calls.find((call) => call.path.endsWith("/rescue/confirm"))?.body).toEqual({ rescueSignatures: [sig(6)] });
    for (const bad of [{ kind: "rescue", step: "confirm", signatures: [] }, { kind: "rescue", step: "confirm", signatures: ["0OIl"] }, { kind: "drain", step: "prepare" }]) {
      expect((await recoveryCall(bad)).status).toBe(400);
    }
  });
});
