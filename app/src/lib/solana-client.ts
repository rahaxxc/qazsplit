import { createClient } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { walletSigner } from "@solana/kit-plugin-wallet";

import { DEVNET_CHAIN, DEVNET_RPC_URL } from "./constants";

export const solanaClient = createClient()
  .use(walletSigner({ chain: DEVNET_CHAIN, autoConnect: true }))
  .use(
    solanaRpc({
      rpcUrl: DEVNET_RPC_URL,
      transactionConfig: { version: 1 },
    }),
  );

export type AppClient = Awaited<typeof solanaClient>;

