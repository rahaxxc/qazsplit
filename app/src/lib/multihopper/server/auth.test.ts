import { generateKeyPair, getAddressFromPublicKey, getBase58Decoder, signBytes } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";

import { buildRoutingApprovalMessage, type RoutingRequest } from "../shared";
import { buildRecoveryMessage } from "../shared";
import { checkApprovalFreshness, decodeSignature, issueAccessToken, readBearerToken, verifyAccessToken, verifyRecoveryApproval, verifyRoutingApproval } from "./auth";

const secret = "mh_test_token_secret_for_unit_tests";
let request: RoutingRequest;
let privateKey: CryptoKey;

beforeAll(async () => {
  const keyPair = await generateKeyPair();
  privateKey = keyPair.privateKey;
  request = {
    wallet: await getAddressFromPublicKey(keyPair.publicKey), agreement: "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq", milestoneIndex: 1,
    amountLamports: "250000000", destination: "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8", hops: 3, arrivalSeconds: 300,
    requestId: "3f1c7a52-8d4e-4b6a-9c2f-1e0d5a7b9c31", issuedAt: new Date().toISOString(), origin: "http://localhost:3000",
  };
});

const sign = async (text: string) => getBase58Decoder().decode(await signBytes(privateKey, new TextEncoder().encode(text)));

describe("wallet ownership proof", () => {
  it("accepts the wallet's signature over the exact canonical message", async () => {
    expect(await verifyRoutingApproval(request, await sign(buildRoutingApprovalMessage(request)))).toBe(true);
  });

  it("rejects a signature over different parameters, another wallet, or garbage", async () => {
    const signature = await sign(buildRoutingApprovalMessage(request));
    expect(await verifyRoutingApproval({ ...request, destination: request.agreement }, signature)).toBe(false);
    expect(await verifyRoutingApproval({ ...request, amountLamports: "999999999" }, signature)).toBe(false);
    expect(await verifyRoutingApproval({ ...request, wallet: "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8" }, signature)).toBe(false);
    expect(await verifyRoutingApproval({ ...request, origin: "https://lookalike.example" }, signature)).toBe(false);
    for (const bad of [undefined, "", "0OIl", "1".repeat(88), 42]) expect(await verifyRoutingApproval(request, bad)).toBe(false);
    expect(decodeSignature(signature)).toHaveLength(64);
  });

  it("verifies recovery approvals separately from routing approvals", async () => {
    const recovery = { wallet: request.wallet, requestId: request.requestId, issuedAt: request.issuedAt, origin: request.origin };
    const signature = await sign(buildRecoveryMessage(recovery));
    expect(await verifyRecoveryApproval(recovery, signature)).toBe(true);
    expect(await verifyRoutingApproval(request, signature)).toBe(false);
    expect(await verifyRecoveryApproval({ ...recovery, origin: "https://lookalike.example" }, signature)).toBe(false);
  });

  it("only accepts recent approvals", () => {
    const now = Date.parse("2026-11-15T09:00:00.000Z");
    expect(checkApprovalFreshness("2026-11-15T08:56:00.000Z", now)).toBe("fresh");
    expect(checkApprovalFreshness("2026-11-15T08:54:59.000Z", now)).toBe("expired");
    expect(checkApprovalFreshness("2026-11-15T09:00:30.000Z", now)).toBe("fresh");
    expect(checkApprovalFreshness("2026-11-15T09:02:00.000Z", now)).toBe("future");
  });
});

describe("routing access tokens", () => {
  const claims = { transferId: 42, wallet: "aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX", agreement: "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq", milestoneIndex: 0 };

  it("round-trips claims bound to one transfer and wallet", async () => {
    const token = await issueAccessToken(secret, claims, 1_000);
    expect(token).toMatch(/^qzr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyAccessToken(secret, token, 1_001)).toEqual({ ...claims, issuedAt: 1_000, expiresAt: 1_000 + 7 * 24 * 3600 });
  });

  it("rejects expired, tampered, forged and foreign-secret tokens", async () => {
    const token = await issueAccessToken(secret, claims, 1_000);
    expect(await verifyAccessToken(secret, token, 1_000 + 7 * 24 * 3600)).toBeNull();
    const [prefix, payload, mac] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ v: 1, tid: 43, w: claims.wallet, a: claims.agreement, m: 0, iat: 1_000, exp: 9_999_999_999 })).toString("base64url");
    expect(await verifyAccessToken(secret, `${prefix}.${forgedPayload}.${mac}`, 1_001)).toBeNull();
    const tamperedMac = Buffer.from(mac, "base64url"); tamperedMac[0] ^= 1;
    expect(await verifyAccessToken(secret, `${prefix}.${payload}.${tamperedMac.toString("base64url")}`, 1_001)).toBeNull();
    expect(await verifyAccessToken("another_secret_that_is_long_enough!!", token, 1_001)).toBeNull();
    for (const bad of ["", "qzr1", "qzr1..", "qzr2.a.b", `${token}.extra`, "x".repeat(2_000)]) expect(await verifyAccessToken(secret, bad, 1_001)).toBeNull();
  });

  it("reads only well-formed bearer tokens", () => {
    const withHeader = (value: string) => new Request("https://qazsplit.test", { headers: { authorization: value } });
    expect(readBearerToken(withHeader("Bearer qzr1.abc.def"))).toBe("qzr1.abc.def");
    expect(readBearerToken(withHeader("Basic abc"))).toBeNull();
    expect(readBearerToken(withHeader("Bearer a b"))).toBeNull();
    expect(readBearerToken(new Request("https://qazsplit.test"))).toBeNull();
  });
});
