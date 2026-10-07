import {
  AccountRole,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token";

import {
  DEVNET_GENESIS_HASH,
  MOCK_USDC_DECIMALS,
  PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from "./constants";
import type { AppClient } from "./solana-client";
import type { WalletTransactionVersion } from "./transaction-compat";
import { calculateAllocations } from "./split-math";

const CREATE_SPLIT_DISCRIMINATOR = Uint8Array.from([
  196, 195, 250, 188, 17, 255, 10, 151,
]);
const EXECUTE_SPLIT_DISCRIMINATOR = Uint8Array.from([
  6, 45, 171, 40, 49, 129, 23, 89,
]);
const SPLIT_CONFIG_DISCRIMINATOR = Uint8Array.from([
  49, 201, 50, 228, 22, 142, 12, 222,
]);

export type SplitConfig = {
  address: Address;
  version: number;
  creator: Address;
  mint: Address;
  splitId: bigint;
  recipients: Address[];
  sharesBps: number[];
  bump: number;
};

export type SimulationResult = {
  unitsConsumed: bigint | null;
  logs: readonly string[];
};

function concatBytes(...chunks: readonly ReadonlyUint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(Uint8Array.from(chunk), offset);
    offset += chunk.length;
  }
  return output;
}

function encodeU16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function encodeU32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function encodeU64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, message: string) {
  if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) {
    throw new Error(message);
  }
}

export async function assertDevnet(client: AppClient): Promise<void> {
  const genesisHash = await client.rpc.getGenesisHash().send();
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error("QazSplit is devnet-only. The configured RPC is not Solana devnet.");
  }
}

export async function deriveSplitConfigAddress(
  creator: Address,
  splitId: bigint,
): Promise<readonly [Address, number]> {
  return getProgramDerivedAddress({
    programAddress: PROGRAM_ADDRESS,
    seeds: [
      getUtf8Encoder().encode("split"),
      getAddressEncoder().encode(creator),
      encodeU64(splitId),
    ],
  });
}

export async function buildCreateSplitInstruction(input: {
  creator: Address;
  mint: Address;
  splitId: bigint;
  recipients: readonly Address[];
  sharesBps: readonly number[];
}): Promise<{ instruction: Instruction; splitConfig: Address }> {
  const [splitConfig] = await deriveSplitConfigAddress(input.creator, input.splitId);
  const recipientBytes = input.recipients.map((recipient) =>
    getAddressEncoder().encode(recipient),
  );
  const shareBytes = input.sharesBps.map(encodeU16);

  return {
    splitConfig,
    instruction: {
      programAddress: PROGRAM_ADDRESS,
      accounts: [
        { address: input.creator, role: AccountRole.WRITABLE_SIGNER },
        { address: input.mint, role: AccountRole.READONLY },
        { address: splitConfig, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: concatBytes(
        CREATE_SPLIT_DISCRIMINATOR,
        encodeU64(input.splitId),
        encodeU32(input.recipients.length),
        ...recipientBytes,
        encodeU32(input.sharesBps.length),
        ...shareBytes,
      ),
    },
  };
}

export async function buildExecuteSplitInstructions(input: {
  payer: TransactionSigner;
  config: SplitConfig;
  amount: bigint;
}): Promise<{ instructions: Instruction[]; payerAta: Address; recipientAtas: Address[] }> {
  const [payerAta] = await findAssociatedTokenPda({
    owner: input.payer.address,
    mint: input.config.mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const recipientAtas = await Promise.all(
    input.config.recipients.map(async (recipient) => {
      const [ata] = await findAssociatedTokenPda({
        owner: recipient,
        mint: input.config.mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      return ata;
    }),
  );

  const createAtaInstructions = recipientAtas.map((ata, index) =>
    getCreateAssociatedTokenIdempotentInstruction({
      payer: input.payer,
      ata,
      owner: input.config.recipients[index],
      mint: input.config.mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
  );

  const executeInstruction: Instruction = {
    programAddress: PROGRAM_ADDRESS,
    accounts: [
      { address: input.payer.address, role: AccountRole.READONLY_SIGNER },
      { address: input.config.address, role: AccountRole.READONLY },
      { address: input.config.mint, role: AccountRole.READONLY },
      { address: payerAta, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ...recipientAtas.map((ata) => ({ address: ata, role: AccountRole.WRITABLE })),
    ],
    data: concatBytes(EXECUTE_SPLIT_DISCRIMINATOR, encodeU64(input.amount)),
  };

  return {
    instructions: [...createAtaInstructions, executeInstruction],
    payerAta,
    recipientAtas,
  };
}

export async function simulateInstructions(
  client: AppClient,
  payer: Address,
  instructions: readonly Instruction[],
  version: WalletTransactionVersion = 1,
): Promise<SimulationResult> {
  await assertDevnet(client);
  const { value: latestBlockhash } = await client.rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();

  const message = version === 1 ? pipe(
    createTransactionMessage({ version: 1 }),
    (current) => setTransactionMessageFeePayer(payer, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) =>
      setTransactionMessageConfig(
        { computeUnitLimit: 400_000, loadedAccountsDataSizeLimit: 1024 * 1024 },
        current,
      ),
    (current) => appendTransactionMessageInstructions(instructions, current),
  ) : pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(payer, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, current),
    (current) => setTransactionMessageComputeUnitLimit(400_000, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );

  const transaction = compileTransaction(message);
  assertIsTransactionWithinSizeLimit(transaction);
  const wireTransaction = getBase64EncodedWireTransaction(transaction);
  const response = await client.rpc
    .simulateTransaction(wireTransaction, {
      commitment: "confirmed",
      encoding: "base64",
      sigVerify: false,
    })
    .send();

  if (response.value.err) {
    const logs = response.value.logs?.join("\n") ?? "No simulation logs were returned.";
    throw new Error(`Transaction simulation failed.\n${logs}`);
  }

  return {
    unitsConsumed: response.value.unitsConsumed ?? null,
    logs: response.value.logs ?? [],
  };
}

export async function fetchSplitConfig(
  client: AppClient,
  splitConfigAddress: string,
): Promise<SplitConfig> {
  await assertDevnet(client);
  const configAddress = address(splitConfigAddress);
  const response = await client.rpc
    .getAccountInfo(configAddress, { commitment: "confirmed", encoding: "base64" })
    .send();
  const account = response.value;
  if (!account) throw new Error("Split config was not found on devnet.");
  if (account.owner !== PROGRAM_ADDRESS) {
    throw new Error("Split config is not owned by the QazSplit program.");
  }

  const bytes = getBase64Encoder().encode(account.data[0]);
  if (bytes.length !== 253) throw new Error("Split config has an unexpected data length.");
  assertBytesEqual(
    bytes.slice(0, 8),
    SPLIT_CONFIG_DISCRIMINATOR,
    "Split config discriminator is invalid.",
  );

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  const version = bytes[offset++];
  const creator = getAddressDecoder().decode(bytes.slice(offset, offset + 32));
  offset += 32;
  const mint = getAddressDecoder().decode(bytes.slice(offset, offset + 32));
  offset += 32;
  const splitId = view.getBigUint64(offset, true);
  offset += 8;
  const recipientCount = bytes[offset++];
  if (recipientCount < 2 || recipientCount > 5) {
    throw new Error("Split config recipient count is invalid.");
  }

  const allRecipients: Address[] = [];
  for (let index = 0; index < 5; index += 1) {
    allRecipients.push(getAddressDecoder().decode(bytes.slice(offset, offset + 32)));
    offset += 32;
  }
  const allShares: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    allShares.push(view.getUint16(offset, true));
    offset += 2;
  }
  const bump = bytes[offset];

  const config: SplitConfig = {
    address: configAddress,
    version,
    creator,
    mint,
    splitId,
    recipients: allRecipients.slice(0, recipientCount),
    sharesBps: allShares.slice(0, recipientCount),
    bump,
  };
  if (config.version !== 1) {
    throw new Error("Split config version is not supported.");
  }
  const [expectedAddress, expectedBump] = await deriveSplitConfigAddress(
    config.creator,
    config.splitId,
  );
  if (expectedAddress !== config.address || expectedBump !== config.bump) {
    throw new Error("Split config PDA does not match its stored creator and split ID.");
  }
  calculateAllocations(1n, config.sharesBps);
  return config;
}

export async function fetchTokenBalance(
  client: AppClient,
  tokenAccount: Address,
): Promise<bigint> {
  const account = await client.rpc
    .getAccountInfo(tokenAccount, { commitment: "confirmed", encoding: "base64" })
    .send();
  if (!account.value) {
    return 0n;
  }

  const response = await client.rpc
    .getTokenAccountBalance(tokenAccount, { commitment: "confirmed" })
    .send();
  if (response.value.decimals !== MOCK_USDC_DECIMALS) {
    throw new Error("Token account has unexpected decimals.");
  }
  return BigInt(response.value.amount);
}

