import "server-only";

/** Devnet only. There is intentionally no override: this integration must never reach mainnet. */
export const MULTIHOPPER_DEVNET_API_BASE_URL = "https://devnet.multihopper.com/api/v1";
const DEVNET_KEY_PREFIX = "mh_test_";
const MIN_ROUTING_SECRET_LENGTH = 32;

export class MultiHopperConfigError extends Error {
  constructor(readonly reason: "missing_api_key" | "non_devnet_api_key" | "weak_routing_secret") {
    // Never include the configured values in the message.
    super(reason === "missing_api_key" ? "MULTIHOPPER_API_KEY is not set."
      : reason === "non_devnet_api_key" ? "MULTIHOPPER_API_KEY must be a devnet mh_test_ key."
        : `QAZSPLIT_ROUTING_SECRET must be at least ${MIN_ROUTING_SECRET_LENGTH} characters when set.`);
    this.name = "MultiHopperConfigError";
  }
}

export type MultiHopperConfig = {
  apiKey: string;
  /** Input key material for QazSplit's own routing access tokens (HKDF-derived, never sent anywhere). */
  tokenSecret: string;
};

export function readMultiHopperConfig(env: Readonly<Record<string, string | undefined>> = process.env): MultiHopperConfig {
  const apiKey = env.MULTIHOPPER_API_KEY?.trim();
  if (!apiKey) throw new MultiHopperConfigError("missing_api_key");
  // Devnet issues only mh_test_ keys; refusing anything else keeps mainnet credentials out.
  if (!apiKey.startsWith(DEVNET_KEY_PREFIX) || apiKey.length <= DEVNET_KEY_PREFIX.length) {
    throw new MultiHopperConfigError("non_devnet_api_key");
  }
  const routingSecret = env.QAZSPLIT_ROUTING_SECRET?.trim();
  if (routingSecret && routingSecret.length < MIN_ROUTING_SECRET_LENGTH) throw new MultiHopperConfigError("weak_routing_secret");
  return { apiKey, tokenSecret: routingSecret || apiKey };
}

/** Removes anything that looks like a MultiHopper key or a routing token from text bound for logs or clients. */
export function redactSecrets(text: string, ...secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) if (secret) output = output.split(secret).join("[redacted]");
  return output.replace(/mh_(?:test|live)_[A-Za-z0-9_-]+/g, "[redacted]").replace(/qzr1\.[A-Za-z0-9_.-]+/g, "[redacted]");
}
