import { describe, expect, it } from "vitest";

import {
  calculateAllocations,
  formatTokenAmount,
  parsePercentToBps,
  parseTokenAmount,
  validateRecipients,
} from "./split-math";

describe("QazSplit allocation rules", () => {
  it("calculates the valid 50/30/20 split", () => {
    expect(calculateAllocations(10_000_000n, [5_000, 3_000, 2_000])).toEqual([
      5_000_000n,
      3_000_000n,
      2_000_000n,
    ]);
  });

  it("rejects percentages that do not total 100%", () => {
    expect(() => calculateAllocations(10_000_000n, [5_000, 3_000, 1_999])).toThrow(
      "exactly 10,000",
    );
  });

  it("rejects duplicate recipients", () => {
    expect(
      validateRecipients([
        { address: "wallet-a", shareBps: 5_000 },
        { address: "wallet-a", shareBps: 5_000 },
      ]),
    ).toContain("Recipient wallet addresses must be unique.");
  });

  it("assigns every rounding unit to the final recipient", () => {
    const allocations = calculateAllocations(10_000_001n, [5_000, 3_000, 2_000]);
    expect(allocations).toEqual([5_000_000n, 3_000_000n, 2_000_001n]);
    expect(allocations.reduce((sum, value) => sum + value, 0n)).toBe(10_000_001n);
  });

  it("parses basis points without floating-point math", () => {
    expect(parsePercentToBps("33.33")).toBe(3_333);
    expect(parsePercentToBps("100")).toBe(10_000);
    expect(parsePercentToBps("33.333")).toBeNull();
  });

  it("parses and formats six-decimal token values exactly", () => {
    expect(parseTokenAmount("10.000001", 6)).toBe(10_000_001n);
    expect(parseTokenAmount("1.0000001", 6)).toBeNull();
    expect(formatTokenAmount(10_000_001n, 6)).toBe("10.000001");
  });

  it("never emits scientific notation or signed zero", () => {
    expect(formatTokenAmount(1n, 6)).toBe("0.000001");
    expect(formatTokenAmount(0n, 6)).toBe("0");
  });
});

