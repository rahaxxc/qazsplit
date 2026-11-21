// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RoutingApiError, describeRoutingError, loadStoredRoutings, removeStoredRouting, routingApi, saveStoredRouting, withRoutingLock, type StoredRouting,
} from "./client";
import { BundleExecutionError, RoutingBundleError } from "./transactions";

const wallet = "aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX";
const entry = (transferId: number): StoredRouting => ({
  transferId, accessToken: `qzr1.t.${transferId}`, agreement: "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq", milestoneIndex: 0,
  destination: "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8", amountLamports: "250000000", createdAt: "2026-11-15T09:00:00.000Z",
});

beforeEach(() => window.localStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, "locks"); });

describe("cross-tab routing lock", () => {
  it("runs directly when the Web Locks API is unavailable", async () => {
    await expect(withRoutingLock(42, async () => "done")).resolves.toBe("done");
  });

  it("refuses a second concurrent signer for the same transfer", async () => {
    const held = new Set<string>();
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      request: async (name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        try { return await callback({ name }); } finally { held.delete(name); }
      },
    } });
    let release!: () => void;
    const first = withRoutingLock(42, () => new Promise<string>((resolve) => { release = () => resolve("first"); }));
    await expect(withRoutingLock(42, async () => "second")).rejects.toMatchObject({ code: "ROUTING_IN_PROGRESS" });
    await expect(withRoutingLock(43, async () => "other transfer")).resolves.toBe("other transfer");
    release();
    await expect(first).resolves.toBe("first");
  });
});

describe("routing error descriptions", () => {
  it.each([
    [new RoutingApiError(409, "MH_040", "Tier shifted"), { requiresNewQuote: true, resumable: false }],
    [new RoutingApiError(410, "MH_034", "expired"), { requiresNewQuote: true }],
    [new RoutingApiError(422, "MH_037", "failed"), { resumable: true }],
    [new RoutingApiError(503, "MULTIHOPPER_NOT_CONFIGURED", "x"), { resumable: false, message: expect.stringMatching(/not configured/) }],
    [new RoutingApiError(0, "NETWORK_ERROR", "offline"), { resumable: true }],
    [new RoutingBundleError("BLOCKHASH_EXPIRED", "expired"), { resumable: true, code: "BLOCKHASH_EXPIRED" }],
    [new RoutingBundleError("BROADCAST_REJECTED", "rejected before sending"), { resumable: true }],
    [new RoutingBundleError("OUTCOME_UNKNOWN", "unknown"), { resumable: true }], // Resume reconciles first; the UI hides it while keeper funding is unresolved
    [new RoutingBundleError("KEEPER_FUNDING_ALREADY_RECORDED", "duplicate"), { resumable: false }],
    [new RoutingBundleError("KEEPER_JOURNAL_UNAVAILABLE", "no storage"), { resumable: false }],
    [new RoutingBundleError("KEEPER_FUNDING_UNTRACKABLE", "no window"), { resumable: false }],
    [new RoutingBundleError("WALLET_MODIFIED_TRANSACTION", "changed"), { resumable: false }],
    [new Error("User rejected the request."), { code: "WALLET_REJECTED", message: "Signature request was cancelled. Nothing was sent." }],
  ])("describes %s", (error, expected) => {
    expect(describeRoutingError(error)).toMatchObject(expected);
  });

  it("names the stage that failed during broadcast", () => {
    const failure = new BundleExecutionError("Route setup 2 of 2", new RoutingApiError(404, "MH_036", "missing"), { routeInitSignatures: ["a"] });
    expect(describeRoutingError(failure)).toMatchObject({ code: "MH_036", resumable: true, message: expect.stringMatching(/^Route setup 2 of 2: /) });
  });
});

describe("per-device routing references", () => {
  it("saves newest first, de-duplicates, removes and survives corrupt storage", () => {
    saveStoredRouting(wallet, entry(1));
    saveStoredRouting(wallet, entry(2));
    expect(saveStoredRouting(wallet, entry(1)).map((item) => item.transferId)).toEqual([1, 2]);
    expect(removeStoredRouting(wallet, 1).map((item) => item.transferId)).toEqual([2]);
    expect(loadStoredRoutings("another-wallet")).toEqual([]);
    window.localStorage.setItem(`qazsplit:multihopper:v1:${wallet}`, "{not json");
    expect(loadStoredRoutings(wallet)).toEqual([]);
    window.localStorage.setItem(`qazsplit:multihopper:v1:${wallet}`, JSON.stringify([{ transferId: "x" }, entry(3)]));
    expect(loadStoredRoutings(wallet).map((item) => item.transferId)).toEqual([3]);
  });
});

describe("routing API client", () => {
  it("calls only QazSplit's own routes and sends the bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ transfer: { id: 42, status: "active" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await routingApi.status(42, "qzr1.a.b");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/multihopper/transfers/42");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer qzr1.a.b");
    expect(JSON.stringify(init)).not.toMatch(/x-api-key|multihopper\.com/);
  });

  it("surfaces the server's error code and message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "MH_040", message: "Tier shifted" } }), { status: 409 })));
    await expect(routingApi.prepare(42, "t")).rejects.toMatchObject({ status: 409, code: "MH_040", message: "Tier shifted" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(routingApi.estimate({ amountLamports: "1", hops: 3, arrivalSeconds: 300 })).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });
});
