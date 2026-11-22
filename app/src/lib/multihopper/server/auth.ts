import "server-only";

import { address, getBase58Encoder, getPublicKeyFromAddress, verifySignature, type SignatureBytes } from "@solana/kit";

import {
  APPROVAL_MAX_AGE_SECONDS, APPROVAL_MAX_FUTURE_SKEW_SECONDS, buildRecoveryMessage, buildRoutingApprovalMessage, type RecoveryRequest, type RoutingRequest,
} from "../shared";

// QazSplit has no accounts or login. Ownership is proven by a wallet signature over the routing
// request; the server then issues an access token bound to exactly one MultiHopper transfer and
// wallet, so nobody can read or drive another person's transfer by guessing its numeric ID.

const TOKEN_PREFIX = "qzr1";
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_TOKEN_LENGTH = 1_024;
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export type AccessClaims = {
  transferId: number;
  wallet: string;
  agreement: string;
  milestoneIndex: number;
  issuedAt: number;
  expiresAt: number;
};

const keyCache = new Map<string, Promise<CryptoKey>>();
const encoder = new TextEncoder();

function tokenKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    // HKDF gives this purpose its own key even when it falls back to the API key as input material.
    key = crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]).then((base) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: encoder.encode("qazsplit"), info: encoder.encode("multihopper-access-token-v1") },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      ));
    keyCache.set(secret, key);
  }
  return key;
}

export async function issueAccessToken(
  secret: string,
  claims: Omit<AccessClaims, "issuedAt" | "expiresAt">,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload = Buffer.from(JSON.stringify({
    v: 1, tid: claims.transferId, w: claims.wallet, a: claims.agreement, m: claims.milestoneIndex,
    iat: nowSeconds, exp: nowSeconds + TOKEN_TTL_SECONDS,
  })).toString("base64url");
  const signed = `${TOKEN_PREFIX}.${payload}`;
  const mac = await crypto.subtle.sign("HMAC", await tokenKey(secret), encoder.encode(signed));
  return `${signed}.${Buffer.from(mac).toString("base64url")}`;
}

export async function verifyAccessToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<AccessClaims | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !parts[1] || !parts[2]) return null;
  const mac = Buffer.from(parts[2], "base64url");
  if (mac.length !== 32) return null;
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify("HMAC", await tokenKey(secret), mac, encoder.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) return null;
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>; } catch { return null; }
  if (claims.v !== 1 || !Number.isSafeInteger(claims.tid) || typeof claims.w !== "string" || typeof claims.a !== "string"
    || !Number.isInteger(claims.m) || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return null;
  if ((claims.exp as number) <= nowSeconds) return null;
  return {
    transferId: claims.tid as number, wallet: claims.w, agreement: claims.a, milestoneIndex: claims.m as number,
    issuedAt: claims.iat as number, expiresAt: claims.exp as number,
  };
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(header.trim()) : null;
  return match ? match[1] : null;
}

export function decodeSignature(signature: unknown): SignatureBytes | null {
  if (typeof signature !== "string" || !BASE58_SIGNATURE.test(signature)) return null;
  try {
    const bytes = getBase58Encoder().encode(signature);
    return bytes.length === 64 ? (bytes as SignatureBytes) : null;
  } catch { return null; }
}

/** Verifies an ed25519 `solana:signMessage` signature by `wallet` over exactly `message`. */
export async function verifyWalletMessage(wallet: string, message: string, signature: unknown): Promise<boolean> {
  const signatureBytes = decodeSignature(signature);
  if (!signatureBytes) return false;
  try {
    const publicKey = await getPublicKeyFromAddress(address(wallet));
    return await verifySignature(publicKey, signatureBytes, encoder.encode(message));
  } catch {
    // Off-curve or otherwise unusable public keys cannot have produced a valid signature.
    return false;
  }
}

/** Verifies that `request.wallet` signed exactly {@link buildRoutingApprovalMessage}(request). */
export function verifyRoutingApproval(request: RoutingRequest, signature: unknown): Promise<boolean> {
  return verifyWalletMessage(request.wallet, buildRoutingApprovalMessage(request), signature);
}

/** Verifies that `request.wallet` signed exactly {@link buildRecoveryMessage}(request). */
export function verifyRecoveryApproval(request: RecoveryRequest, signature: unknown): Promise<boolean> {
  return verifyWalletMessage(request.wallet, buildRecoveryMessage(request), signature);
}

export function checkApprovalFreshness(issuedAt: string, nowMs = Date.now()): "fresh" | "expired" | "future" {
  const ageSeconds = (nowMs - Date.parse(issuedAt)) / 1000;
  if (ageSeconds < -APPROVAL_MAX_FUTURE_SKEW_SECONDS) return "future";
  return ageSeconds > APPROVAL_MAX_AGE_SECONDS ? "expired" : "fresh";
}
