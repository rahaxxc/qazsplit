import { address, devnet } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

export const DEVNET_CHAIN = "solana:devnet" as const;
export const DEVNET_RPC_URL = devnet(
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
);
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const PROGRAM_ADDRESS = address(
  process.env.NEXT_PUBLIC_QAZSPLIT_PROGRAM_ID ??
    "3zqHQ8gWY2o8ZtfaGZg5JvgntkV6Qdf9zKBrJqufhKJD",
);
export const MOCK_USDC_MINT = address(
  "7S3HyHeoD9WvVt63frsvRU9Kcixw2bRDAeyD8tVC6w8H",
);
export const MOCK_USDC_DECIMALS = 6;
export const MOCK_USDC_SYMBOL = "Mock USDC";
export const CLASSIC_TOKEN_PROGRAM_ADDRESS = TOKEN_PROGRAM_ADDRESS;
export const SYSTEM_PROGRAM_ADDRESS = address(
  "11111111111111111111111111111111",
);
export const BASIS_POINTS_TOTAL = 10_000;
export const MIN_RECIPIENTS = 2;
export const MAX_RECIPIENTS = 5;

