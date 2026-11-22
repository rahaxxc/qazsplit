import { getProgramDerivedAddress } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { MOCK_USDC_MINT, PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS } from "../constants";
import {
  MAX_ROUTING_LAMPORTS, SOL_MINT, buildRecoveryMessage, buildRoutingApprovalMessage, externalIdForRequest, normalizeOrigin, validateRecoveryRequest, formatSol, lamportsToTokenString, parseSolAmount,
  validateArrivalSeconds, validateDestination, validateHops, validateLamports, validateRoutingRequest, type RoutingRequest,
} from "./shared";

const wallet = "aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX";
const destination = "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8";
const agreement = "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq";
const valid: RoutingRequest = {
  wallet, agreement, milestoneIndex: 0, amountLamports: "250000000", destination, hops: 3, arrivalSeconds: 300,
  requestId: "3f1c7a52-8d4e-4b6a-9c2f-1e0d5a7b9c31", issuedAt: "2026-11-15T09:00:00.000Z", origin: "https://qazsplit.example",
};

describe("MultiHopper routing input validation", () => {
  it.each(["", "abc", "-1", "0", "0.0", "1e3", "0.0000000001", "1,5", " ", "∞"])("rejects invalid SOL amount %j", (amount) => {
    expect(parseSolAmount(amount).ok).toBe(false);
  });

  it("parses SOL to exact lamports and caps the prototype at 100 SOL", () => {
    expect(parseSolAmount("0.25")).toEqual({ ok: true, value: 250_000_000n });
    expect(parseSolAmount("0.000000001")).toEqual({ ok: true, value: 1n });
    expect(parseSolAmount("100")).toEqual({ ok: true, value: MAX_ROUTING_LAMPORTS });
    expect(parseSolAmount("100.000000001")).toMatchObject({ ok: false, message: expect.stringMatching(/at most 100 SOL/) });
  });

  it.each([["", "invalid"], ["not-an-address", "invalid"], [`${destination}x`, "invalid"], [wallet, "self"], [SYSTEM_PROGRAM_ADDRESS, "program"],
    [SOL_MINT, "program"], [PROGRAM_ADDRESS, "program"], [MOCK_USDC_MINT, "program"]])("rejects destination %s (%s)", (value) => {
    expect(validateDestination(value, wallet).ok).toBe(false);
  });

  it("rejects a program-derived (off-curve) destination that no key could ever spend from (audit M9)", async () => {
    const [pda] = await getProgramDerivedAddress({ programAddress: PROGRAM_ADDRESS, seeds: ["qazsplit-routing-test"] });
    expect(validateDestination(pda, wallet)).toMatchObject({ ok: false, message: expect.stringMatching(/program-derived/) });
    expect(validateRoutingRequest({ ...valid, destination: pda }).ok).toBe(false);
  });

  it("accepts a distinct wallet destination and trims surrounding spaces", () => {
    expect(validateDestination(`  ${destination} `, wallet)).toEqual({ ok: true, value: destination });
  });

  it("enforces documented hop and arrival ranges", () => {
    expect([2, 3, 10, 11, 3.5, "3"].map((hops) => validateHops(hops).ok)).toEqual([false, true, true, false, false, false]);
    expect([59, 60, 86_400, 86_401, 300.5].map((seconds) => validateArrivalSeconds(seconds).ok)).toEqual([false, true, true, false, false]);
    expect(["0", "01", "-5", "1.5", 5, "100000000001"].map((value) => validateLamports(value).ok)).toEqual([false, false, false, false, false, false]);
  });

  it("validates a complete routing request and rejects each malformed field", () => {
    expect(validateRoutingRequest(valid)).toEqual({ ok: true, value: valid });
    const broken: [keyof RoutingRequest, unknown][] = [
      ["wallet", "nope"], ["agreement", 1], ["milestoneIndex", 5], ["amountLamports", "0"], ["destination", wallet], ["destination", ` ${destination}`],
      ["hops", 1], ["arrivalSeconds", 30], ["requestId", "not-a-uuid"], ["requestId", valid.requestId.toUpperCase()], ["issuedAt", "yesterday"],
      ["origin", undefined], ["origin", "http://qazsplit.example"], ["origin", "https://qazsplit.example/"], ["origin", "javascript:alert(1)"],
    ];
    for (const [field, value] of broken) expect(validateRoutingRequest({ ...valid, [field]: value }).ok).toBe(false);
    expect(validateRoutingRequest(null).ok).toBe(false);
  });
});

describe("routing approval message", () => {
  it("is deterministic and states every approved parameter", () => {
    const message = buildRoutingApprovalMessage(valid);
    expect(buildRoutingApprovalMessage({ ...valid })).toBe(message);
    expect(message.split("\n")[0]).toBe("qazsplit.example asks you to approve a QazSplit onward routing request (Solana devnet)");
    for (const part of ["Website: https://qazsplit.example", wallet, agreement, destination, "0.25 SOL (250000000 lamports)", "Hops: 3", "Arrival target: 300 seconds", valid.requestId, valid.issuedAt, "moves no funds", "not affected"]) {
      expect(message).toContain(part);
    }
  });

  it("changes when any approved parameter changes", () => {
    const message = buildRoutingApprovalMessage(valid);
    expect(buildRoutingApprovalMessage({ ...valid, destination: agreement })).not.toBe(message);
    expect(buildRoutingApprovalMessage({ ...valid, amountLamports: "250000001" })).not.toBe(message);
    expect(buildRoutingApprovalMessage({ ...valid, hops: 4 })).not.toBe(message);
    expect(buildRoutingApprovalMessage({ ...valid, origin: "https://qazsp1it.example" })).not.toBe(message);
  });

  it("accepts https origins, and http only for local development", () => {
    expect(normalizeOrigin("https://qazsplit.example")).toBe("https://qazsplit.example");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    for (const bad of ["http://qazsplit.example", "https://qazsplit.example/app", "ftp://x.example", "", 42, null]) expect(normalizeOrigin(bad)).toBeNull();
  });

  it("builds a recovery message that names the site and cannot create anything", () => {
    const recovery = { wallet, requestId: valid.requestId, issuedAt: valid.issuedAt, origin: valid.origin };
    expect(validateRecoveryRequest(recovery)).toEqual({ ok: true, value: recovery });
    expect(validateRecoveryRequest({ ...recovery, origin: "http://evil.example" }).ok).toBe(false);
    const message = buildRecoveryMessage(recovery);
    expect(message.split("\n")[0]).toContain("qazsplit.example");
    expect(message).toContain("moves no funds");
    expect(message).not.toBe(buildRoutingApprovalMessage(valid));
  });

  it("formats MultiHopper amountTokens and external IDs", () => {
    expect(lamportsToTokenString(1_000_000_000n)).toBe("1.0");
    expect(lamportsToTokenString(250_000_000n)).toBe("0.25");
    expect(lamportsToTokenString(1n)).toBe("0.000000001");
    expect(formatSol("1500000000000")).toBe("1,500");
    expect(externalIdForRequest(valid.requestId)).toMatch(/^qzs-[0-9a-f-]{36}$/);
  });
});
