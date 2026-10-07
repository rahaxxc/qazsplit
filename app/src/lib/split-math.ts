import { BASIS_POINTS_TOTAL, MAX_RECIPIENTS, MIN_RECIPIENTS } from "./constants";

export type RecipientInput = {
  address: string;
  shareBps: number;
};

export function parsePercentToBps(value: string): number | null {
  const normalized = value.trim();
  const match = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(normalized);
  if (!match) return null;

  const whole = Number(match[1]);
  const fractional = (match[2] ?? "").padEnd(2, "0");
  const bps = whole * 100 + Number(fractional || "0");
  return Number.isSafeInteger(bps) && bps <= BASIS_POINTS_TOTAL ? bps : null;
}

export function parseTokenAmount(value: string, decimals = 6): bigint | null {
  const normalized = value.trim();
  const match = new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimals}}))?$`).exec(normalized);
  if (!match) return null;

  const whole = BigInt(match[1]);
  const fractional = (match[2] ?? "").padEnd(decimals, "0");
  const raw = whole * 10n ** BigInt(decimals) + BigInt(fractional || "0");
  return raw > 0n ? raw : null;
}

export function formatTokenAmount(raw: bigint, decimals = 6): string {
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = absolute / divisor;
  const fraction = (absolute % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

export function calculateAllocations(amount: bigint, sharesBps: readonly number[]): bigint[] {
  if (amount <= 0n) throw new Error("Amount must be greater than zero.");
  if (sharesBps.length < MIN_RECIPIENTS || sharesBps.length > MAX_RECIPIENTS) {
    throw new Error("A split must contain between two and five recipients.");
  }
  if (sharesBps.some((share) => !Number.isInteger(share) || share <= 0)) {
    throw new Error("Each share must be a positive whole number of basis points.");
  }
  if (sharesBps.reduce((sum, share) => sum + share, 0) !== BASIS_POINTS_TOTAL) {
    throw new Error("Shares must total exactly 10,000 basis points.");
  }

  let distributed = 0n;
  return sharesBps.map((share, index) => {
    const allocation =
      index === sharesBps.length - 1
        ? amount - distributed
        : (amount * BigInt(share)) / BigInt(BASIS_POINTS_TOTAL);
    distributed += allocation;
    return allocation;
  });
}

export function validateRecipients(recipients: readonly RecipientInput[]): string[] {
  const errors: string[] = [];
  if (recipients.length < MIN_RECIPIENTS || recipients.length > MAX_RECIPIENTS) {
    errors.push("Use between two and five recipients.");
  }
  if (new Set(recipients.map((recipient) => recipient.address.trim())).size !== recipients.length) {
    errors.push("Recipient wallet addresses must be unique.");
  }
  if (recipients.some((recipient) => recipient.shareBps <= 0)) {
    errors.push("Every recipient needs a positive share.");
  }
  const total = recipients.reduce((sum, recipient) => sum + recipient.shareBps, 0);
  if (total !== BASIS_POINTS_TOTAL) {
    errors.push(`Shares total ${total.toLocaleString("en-US")} bps; they must total 10,000 bps.`);
  }
  return errors;
}

