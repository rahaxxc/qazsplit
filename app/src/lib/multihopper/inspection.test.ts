import {
  AccountRole, compileTransaction, createNoopSigner, createTransactionMessage, decompileTransactionMessage, generateKeyPair, getAddressFromPublicKey,
  getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, partiallySignTransaction, pipe,
  appendTransactionMessageInstructions, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  signBytes, verifySignature,
  type Address, type Blockhash, type Instruction, type SignatureBytes, type Transaction, type TransactionModifyingSigner,
} from "@solana/kit";
import { getAdvanceNonceAccountInstruction, getAssignInstruction, getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import { getApproveInstruction, getCloseAccountInstruction, getTransferInstruction } from "@solana-program/token";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PRIORITY_FEE_CAP_LAMPORTS, PROGRAMS, createOutflowGuard, decodeMessage, priorityFeeLamports, type OutflowRpc } from "./inspection";
import { guarded, planBundle, signBundle, type BundleStep, type PreparedTxs } from "./transactions";

const BLOCKHASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" as Blockhash;
const OTHER_BLOCKHASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" as Blockhash;
const CORE = PROGRAMS.multihopperCore as Address;
const ORCHESTRATOR = PROGRAMS.multihopperOrchestrator as Address;
const CB = PROGRAMS.computeBudget as Address;
const BOTH = new Set<"legacy" | 0 | 1>(["legacy", 0]);
const ATTACKER = "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ" as Address;
const USER_USDC_ACCOUNT = "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8" as Address;
const UNKNOWN_PROGRAM = "Stake11111111111111111111111111111111111111" as Address;

let user: { address: Address; keys: CryptoKeyPair };
let ephemeral: { address: Address; keys: CryptoKeyPair };

async function keyPair() {
  const keys = await generateKeyPair();
  return { keys, address: await getAddressFromPublicKey(keys.publicKey) };
}

beforeAll(async () => { user = await keyPair(); ephemeral = await keyPair(); });

const u32 = (value: number) => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value, true); return out; };
const u64 = (value: bigint) => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, value, true); return out; };
const cuLimit = (units: number): Instruction => ({ programAddress: CB, data: Uint8Array.from([2, ...u32(units)]) });
const cuPrice = (microLamports: bigint): Instruction => ({ programAddress: CB, data: Uint8Array.from([3, ...u64(microLamports)]) });
const core = (tag: number, coSigned = false): Instruction => ({
  programAddress: CORE, data: new Uint8Array([tag]),
  accounts: [{ address: user.address, role: AccountRole.WRITABLE_SIGNER }, ...(coSigned ? [{ address: ephemeral.address, role: AccountRole.READONLY_SIGNER }] : [])],
});

/** A transaction as MultiHopper prepares it: the recipient pays fees; `coSigned` adds a pre-signed ephemeral key. */
async function build(version: "legacy" | 0, instructions: Instruction[], options: { coSigned?: boolean; blockhash?: Blockhash } = {}): Promise<Transaction> {
  const message = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayer(user.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: options.blockhash ?? BLOCKHASH, lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const compiled = compileTransaction(message);
  return options.coSigned ? partiallySignTransaction([ephemeral.keys], compiled) : compiled;
}
const wire = async (...args: Parameters<typeof build>) => getBase64EncodedWireTransaction(await build(...args));

async function bundle(overrides: Partial<PreparedTxs> = {}): Promise<PreparedTxs> {
  return {
    keeperFundingTx: await wire(0, [getTransferSolInstruction({ source: createNoopSigner(user.address), destination: ATTACKER, amount: 2_000_000n })]),
    routeInitTxs: [await wire(0, [core(2, true)], { coSigned: true })],
    orchestratorInitTx: await wire("legacy", [{ ...core(4), programAddress: ORCHESTRATOR }]),
    sessionInitTxs: [await wire(0, [core(5, true)], { coSigned: true })],
    dispersionInitTxs: [],
    recentBlockhash: BLOCKHASH, lastValidBlockHeight: 100, nothingToDo: false,
    ...overrides,
  };
}

type Rewrite = (instructions: readonly Instruction[], tx: Transaction) => { instructions: readonly Instruction[]; blockhash?: Blockhash } | null;

/**
 * A Wallet Standard signer that may rewrite the message before signing, as Phantom does for
 * priority fees. `rewrite` returns null to sign the original bytes unchanged.
 */
function rewritingWallet(rewrite: Rewrite, options: { signOriginal?: boolean } = {}): TransactionModifyingSigner & { calls: number } {
  const signer = {
    address: user.address,
    calls: 0,
    async modifyAndSignTransactions(transactions: readonly Transaction[]) {
      signer.calls++;
      return Promise.all(transactions.map(async (tx) => {
        const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
        const message = decompileTransactionMessage(compiled as never) as unknown as { instructions: readonly Instruction[]; version: "legacy" | 0 };
        const change = rewrite(message.instructions, tx);
        let messageBytes = tx.messageBytes;
        if (change) {
          const rebuilt = pipe(
            createTransactionMessage({ version: message.version }),
            (m) => setTransactionMessageFeePayer(user.address, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: change.blockhash ?? BLOCKHASH, lastValidBlockHeight: 100n }, m),
            (m) => appendTransactionMessageInstructions(change.instructions, m),
          );
          messageBytes = compileTransaction(rebuilt).messageBytes;
        }
        const own = await signBytes(user.keys.privateKey, options.signOriginal ? tx.messageBytes : messageBytes);
        const signatures = change ? { [user.address]: own } : { ...tx.signatures, [user.address]: own };
        return { messageBytes, signatures, lifetimeConstraint: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } };
      }));
    },
  };
  return signer as unknown as TransactionModifyingSigner & { calls: number };
}

const hasSignatures = (tx: Transaction) => Object.values(tx.signatures).some(Boolean);
const hasComputeBudget = (instructions: readonly Instruction[]) => instructions.some((instruction) => instruction.programAddress === CB);

/** Phantom's documented behaviour: add priority-fee instructions to transactions with no signatures and no Compute Budget. */
const phantom = () => rewritingWallet((instructions, tx) => (hasSignatures(tx) || hasComputeBudget(instructions)
  ? null : { instructions: [cuLimit(200_000), cuPrice(100_000n), ...instructions] }));

const codeOf = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return (error as { code?: string }).code ?? String(error); } };

describe("wallet-added Compute Budget instructions (audit C1)", () => {
  it("accepts Phantom's priority fee on recipient-only transactions and keeps MultiHopper's pre-signed ones byte-identical", async () => {
    const steps = planBundle(await bundle(), user.address, BOTH);
    const signed = await signBundle(steps, phantom(), user.address);
    const userKey = await getPublicKeyFromAddress(user.address);
    for (const [i, step] of signed.entries()) {
      const coSigned = Object.keys(steps[i].transaction.signatures).includes(ephemeral.address);
      if (coSigned) {
        expect(step.transaction.messageBytes).toEqual(steps[i].transaction.messageBytes);
        expect(step.transaction.signatures[ephemeral.address]).toEqual(steps[i].transaction.signatures[ephemeral.address]);
      } else {
        expect(step.transaction.messageBytes).not.toEqual(steps[i].transaction.messageBytes);
        expect(step.review.hasComputeBudget).toBe(true);
        expect(Object.keys(step.transaction.signatures)).toEqual([user.address]);
      }
      expect(await verifySignature(userKey, step.transaction.signatures[user.address] as SignatureBytes, step.transaction.messageBytes)).toBe(true);
    }
    // The keeper-funding amount and destination are untouched by the wallet's change.
    expect(signed[0].review.systemOutflowLamports).toBe(2_000_000n);
  });

  it("rejects any change to a transaction MultiHopper co-signed (it would invalidate that signature)", async () => {
    const steps = planBundle(await bundle(), user.address, BOTH);
    const greedy = rewritingWallet((instructions) => (hasComputeBudget(instructions) ? null : { instructions: [cuPrice(1_000n), ...instructions] }));
    await expect(signBundle(steps, greedy, user.address)).rejects.toMatchObject({ code: "WALLET_MODIFIED_TRANSACTION", message: expect.stringMatching(/also signed by MultiHopper/) });
  });

  it.each<[string, Rewrite]>([
    ["adds a transfer to another account", (instructions) => ({ instructions: [...instructions, getTransferSolInstruction({ source: createNoopSigner(user.address), destination: ATTACKER, amount: 1n })] })],
    ["drops MultiHopper's instruction", () => ({ instructions: [cuPrice(1_000n)] })],
    ["changes the transfer amount", () => ({ instructions: [getTransferSolInstruction({ source: createNoopSigner(user.address), destination: ATTACKER, amount: 9_000_000n })] })],
    ["swaps the blockhash", (instructions) => ({ instructions, blockhash: OTHER_BLOCKHASH })],
    ["adds a priority fee above the 0.005 SOL cap", (instructions) => ({ instructions: [cuLimit(1_400_000), cuPrice(10_000_000n), ...instructions] })],
    ["adds duplicate Compute Budget instructions", (instructions) => ({ instructions: [cuPrice(1n), cuPrice(2n), ...instructions] })],
    ["adds a malformed Compute Budget instruction", (instructions) => ({ instructions: [{ programAddress: CB, data: new Uint8Array([3, 1]) }, ...instructions] })],
  ])("rejects a wallet that %s", async (_, rewrite) => {
    const steps = planBundle(await bundle({ routeInitTxs: [], orchestratorInitTx: null, sessionInitTxs: [] }), user.address, BOTH);
    const wallet = rewritingWallet((instructions, tx) => (hasSignatures(tx) ? null : rewrite(instructions, tx)));
    await expect(signBundle(steps, wallet, user.address)).rejects.toMatchObject({ code: "WALLET_MODIFIED_TRANSACTION" });
  });

  it("rejects a changed transaction whose wallet signature does not cover the changed bytes", async () => {
    const steps = planBundle(await bundle({ routeInitTxs: [], orchestratorInitTx: null, sessionInitTxs: [] }), user.address, BOTH);
    const wallet = rewritingWallet((instructions) => ({ instructions: [cuPrice(1_000n), ...instructions] }), { signOriginal: true });
    await expect(signBundle(steps, wallet, user.address)).rejects.toMatchObject({ code: "WALLET_MODIFIED_TRANSACTION", message: expect.stringMatching(/signature does not match/) });
  });

  it("never lets a wallet change Compute Budget settings MultiHopper already chose", async () => {
    const prepared = await bundle({ keeperFundingTx: await wire(0, [cuPrice(5n), core(1)]), routeInitTxs: [], orchestratorInitTx: null, sessionInitTxs: [] });
    const steps = planBundle(prepared, user.address, BOTH);
    const wallet = rewritingWallet((instructions) => ({ instructions: instructions.map((i) => (i.programAddress === CB ? cuPrice(50_000n) : i)) }));
    await expect(signBundle(steps, wallet, user.address)).rejects.toMatchObject({ code: "WALLET_MODIFIED_TRANSACTION" });
    // Phantom leaves such a transaction alone, which is accepted as-is.
    await expect(signBundle(steps, phantom(), user.address)).resolves.toHaveLength(1);
  });

  it("computes the worst-case priority fee from the unit limit, or from the default per-instruction budget", async () => {
    const withLimit = decodeMessage((await build(0, [cuLimit(200_000), cuPrice(1_000_000n), core(1)])).messageBytes);
    expect(priorityFeeLamports(withLimit.instructions)).toBe(200_000n);
    const withoutLimit = decodeMessage((await build(0, [cuPrice(1_000_000n), core(1), core(2)])).messageBytes);
    expect(priorityFeeLamports(withoutLimit.instructions)).toBe(400_000n); // 2 instructions × 200k default units
    expect(PRIORITY_FEE_CAP_LAMPORTS).toBe(5_000_000n);
  });
});

describe("bundle semantics before any signature is requested (audit M3)", () => {
  const plan = async (keeperFundingTx: string) => planBundle(await bundle({ keeperFundingTx, routeInitTxs: [], orchestratorInitTx: null, sessionInitTxs: [] }), user.address, BOTH);
  const planCode = async (instructions: Instruction[]) => {
    const encoded = await wire(0, instructions);
    try { await plan(encoded); return null; } catch (error) { return (error as { code?: string; message: string }); }
  };

  it("refuses programs QazSplit does not recognize, naming them", async () => {
    const error = await planCode([{ programAddress: UNKNOWN_PROGRAM, accounts: [{ address: user.address, role: AccountRole.WRITABLE_SIGNER }], data: new Uint8Array([1]) }]);
    expect(error).toMatchObject({ code: "TRANSACTION_INTEGRITY", message: expect.stringContaining(UNKNOWN_PROGRAM) });
  });

  it.each<[string, () => Instruction]>([
    ["re-assign the wallet to another program", () => getAssignInstruction({ account: createNoopSigner(user.address), programAddress: ATTACKER })],
    ["move the wallet's mock-USDC tokens", () => getTransferInstruction({ source: USER_USDC_ACCOUNT, destination: ATTACKER, authority: createNoopSigner(user.address), amount: 1n })],
    ["delegate the wallet's tokens", () => getApproveInstruction({ source: USER_USDC_ACCOUNT, delegate: ATTACKER, owner: createNoopSigner(user.address), amount: 1n })],
    ["close a token account to someone else", () => getCloseAccountInstruction({ account: USER_USDC_ACCOUNT, destination: ATTACKER, owner: createNoopSigner(user.address) })],
    ["use a durable nonce", () => getAdvanceNonceAccountInstruction({ nonceAccount: ATTACKER, nonceAuthority: createNoopSigner(user.address) })],
  ])("refuses a transaction that would %s", async (_, instruction) => {
    expect(await planCode([instruction()])).toMatchObject({ code: "TRANSACTION_INTEGRITY" });
  });

  it("allows closing a token account back to the wallet itself", async () => {
    expect(await planCode([getCloseAccountInstruction({ account: USER_USDC_ACCOUNT, destination: user.address, owner: createNoopSigner(user.address) })])).toBeNull();
  });

  it("refuses a bundle still missing MultiHopper's signature before prompting the wallet", async () => {
    const unsigned = await wire(0, [core(2, true)]); // co-signer slot left empty
    const wallet = phantom();
    expect(codeOf(() => planBundle({ ...(awaitedBundle), routeInitTxs: [unsigned] }, user.address, BOTH))).toBe("INCOMPLETE_SIGNATURES");
    expect(wallet.calls).toBe(0);
  });

  it("summarizes signers, programs and direct SOL outflow for the review panel", async () => {
    const steps = planBundle(await bundle({
      keeperFundingTx: await wire(0, [
        getTransferSolInstruction({ source: createNoopSigner(user.address), destination: ATTACKER, amount: 1_500_000n }),
        getCreateAccountInstruction({ payer: createNoopSigner(user.address), newAccount: createNoopSigner(ephemeral.address), lamports: 890_880n, space: 0, programAddress: CORE }),
      ], { coSigned: true }),
    }), user.address, BOTH);
    expect(steps[0].review.systemOutflowLamports).toBe(2_390_880n);
    expect(steps[0].review.programs).toEqual(["System Program"]);
    const route = steps.find((step) => step.group === "routeInit") as BundleStep;
    expect(route.review.signers).toEqual([{ address: user.address, role: "you" }, { address: ephemeral.address, role: "multihopper-presigned" }]);
    expect(route.review.programs).toEqual(["MultiHopper Core"]);
  });
});

let awaitedBundle: PreparedTxs;
beforeAll(async () => { awaitedBundle = await bundle(); });

describe("simulation outflow guard", () => {
  function rpc(script: { balance?: bigint; post?: (bigint | null)[]; errs?: unknown[]; fail?: boolean }) {
    const posts = [...(script.post ?? [])];
    const errs = [...(script.errs ?? [])];
    const simulateTransaction = vi.fn(() => ({ send: async () => {
      if (script.fail) throw new TypeError("fetch failed");
      const post = posts.length > 1 ? posts.shift() : posts[0];
      return { value: { err: errs.length ? errs.shift() : null, accounts: post === undefined ? null : [post === null ? null : { lamports: post }] } };
    } }));
    const getBalance = vi.fn(() => ({ send: async () => ({ value: script.balance ?? 1_000_000_000n }) }));
    return { rpc: { getBalance, simulateTransaction } as unknown as OutflowRpc, simulateTransaction, getBalance };
  }

  it("simulates against the wallet's account without signature checks or blockhash replacement", async () => {
    const { rpc: mock, simulateTransaction } = rpc({ post: [999_000_000n] });
    const guard = createOutflowGuard({ rpc: mock, wallet: user.address, limitLamports: 5_000_000n });
    const transaction = await build(0, [core(1)]);
    expect(await guard.check(transaction)).toBe(1_000_000n);
    expect(simulateTransaction).toHaveBeenCalledWith(getBase64EncodedWireTransaction(transaction), expect.objectContaining({
      encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, accounts: { addresses: [user.address], encoding: "base64" },
    }));
  });

  it("stops the bundle before the transaction that would exceed the quoted amount, and never sends it", async () => {
    const { rpc: mock } = rpc({ post: [997_000_000n] }); // 3,000,000 lamports per transaction
    const guard = createOutflowGuard({ rpc: mock, wallet: user.address, limitLamports: 5_000_000n });
    const send = vi.fn(async () => "sig");
    const sender = guarded({ check: (tx) => guard.check(tx), record: (lamports) => guard.record(lamports) }, send);
    const step = { group: "routeInit", index: 0, transaction: await build(0, [core(1)]) } as BundleStep;
    await expect(sender(step)).resolves.toBe("sig");
    expect(guard.spentLamports).toBe(3_000_000n);
    await expect(sender(step)).rejects.toMatchObject({ code: "OUTFLOW_LIMIT_EXCEEDED" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries a failing simulation (dependent accounts may lag), then refuses to send", async () => {
    const sleeps: number[] = [];
    const flaky = rpc({ post: [999_000_000n], errs: [{ InstructionError: [0, "Custom"] }] });
    const guard = createOutflowGuard({ rpc: flaky.rpc, wallet: user.address, limitLamports: 5_000_000n, sleep: async (ms) => { sleeps.push(ms); } });
    await expect(guard.check(await build(0, [core(1)]))).resolves.toBe(1_000_000n);
    expect(sleeps).toEqual([2_000]);
    const failing = rpc({ post: [999_000_000n], errs: ["AccountNotFound", "AccountNotFound", "AccountNotFound"] });
    const strict = createOutflowGuard({ rpc: failing.rpc, wallet: user.address, limitLamports: 5_000_000n, sleep: async () => {} });
    await expect(strict.check(await build(0, [core(1)]))).rejects.toMatchObject({ code: "SIMULATION_REJECTED" });
    expect(failing.simulateTransaction).toHaveBeenCalledTimes(3);
  });

  it("fails closed when devnet RPC cannot simulate or omits the wallet's balance", async () => {
    const transaction = await build(0, [core(1)]);
    await expect(createOutflowGuard({ rpc: rpc({ fail: true }).rpc, wallet: user.address, limitLamports: 1n }).check(transaction)).rejects.toMatchObject({ code: "VALIDATION_UNAVAILABLE" });
    await expect(createOutflowGuard({ rpc: rpc({ post: [null] }).rpc, wallet: user.address, limitLamports: 1n }).check(transaction)).rejects.toMatchObject({ code: "VALIDATION_UNAVAILABLE" });
  });

  it("counts a transaction that returns SOL to the wallet as no outflow", async () => {
    const guard = createOutflowGuard({ rpc: rpc({ balance: 100n, post: [5_000_100n] }).rpc, wallet: user.address, limitLamports: 0n });
    await expect(guard.check(await build(0, [core(1)]))).resolves.toBe(0n);
  });
});

describe("wallet safety while signing", () => {
  it("gives up on a wallet that never answers and aborts its request", async () => {
    let signal: AbortSignal | undefined;
    const stuck = { address: user.address, modifyAndSignTransactions: (_: unknown, config?: { abortSignal?: AbortSignal }) => { signal = config?.abortSignal; return new Promise<never>(() => {}); } };
    const steps = planBundle(await bundle(), user.address, BOTH);
    await expect(signBundle(steps, stuck as unknown as TransactionModifyingSigner, user.address, { timeoutMs: 5 })).rejects.toMatchObject({ code: "WALLET_TIMEOUT" });
    expect(signal?.aborted).toBe(true);
  });

  it("discards signatures if the wallet switched accounts during the prompt", async () => {
    const steps = planBundle(await bundle(), user.address, BOTH);
    await expect(signBundle(steps, phantom(), user.address, { currentAccount: () => ATTACKER })).rejects.toMatchObject({ code: "WALLET_ACCOUNT_CHANGED" });
  });

  it("passes the wallet's own rejection through unchanged, so the UI reports it as cancelled", async () => {
    const declining = { address: user.address, modifyAndSignTransactions: async () => { throw new Error("User rejected the request."); } };
    await expect(signBundle(planBundle(await bundle(), user.address, BOTH), declining as unknown as TransactionModifyingSigner, user.address)).rejects.toThrow(/rejected/);
  });
});
