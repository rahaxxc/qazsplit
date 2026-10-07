import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import anchor from "@anchor-lang/core";
import {
  createMint, getMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// Operational demo script. Keys are read only from a private directory outside the repo.
const keyDirectory = process.env.QAZSPLIT_DEVNET_KEY_DIR;
if (!keyDirectory) throw new Error("Set QAZSPLIT_DEVNET_KEY_DIR to the private devnet wallet directory.");
const loadKey = async (role: string) => Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(await readFile(join(keyDirectory, `${role}.json`), "utf8"))),
);
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(await connection.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
const deployer = await loadKey("deployer");
const payer = await loadKey("payer");
const mintKey = await loadKey("mint");
const mint = mintKey.publicKey;
const idl = JSON.parse(await readFile(new URL("../target/idl/qazsplit.json", import.meta.url), "utf8"));
const programId = new PublicKey(idl.address);
const programAccount = await connection.getAccountInfo(programId);
assert(programAccount?.executable, "Deploy QazSplit to devnet before preparing the demo.");
const recipients = await Promise.all([0, 1, 2].map(async (index) =>
  (await loadKey(`recipient-${index}`)).publicKey,
));

if (process.argv[2] === "setup") {
  if (!(await connection.getAccountInfo(mint))) {
    await createMint(connection, deployer, deployer.publicKey, null, 6, mintKey);
  }
  const mintInfo = await getMint(connection, mint);
  assert.equal(mintInfo.decimals, 6);
  const payerAccount = await getOrCreateAssociatedTokenAccount(connection, deployer, mint, payer.publicKey);
  const recipientAccounts = await Promise.all(recipients.map((recipient) =>
    getOrCreateAssociatedTokenAccount(connection, deployer, mint, recipient, true),
  ));
  const payerSol = await connection.getBalance(payer.publicKey);
  if (payerSol < 10_000_000) {
    await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({
      fromPubkey: deployer.publicKey, toPubkey: payer.publicKey, lamports: 10_000_000 - payerSol,
    })), [deployer]);
  }
  if (payerAccount.amount < 100_000_000n) {
    await mintTo(connection, deployer, mint, payerAccount.address, deployer, 100_000_000n - payerAccount.amount);
  }
  console.log(JSON.stringify({ cluster: "devnet", program: programId.toBase58(), mint: mint.toBase58(),
    decimals: mintInfo.decimals, payer: payer.publicKey.toBase58(), payerAta: payerAccount.address.toBase58(),
    recipients: recipients.map((recipient, index) => ({ address: recipient.toBase58(),
      shareBps: [5000, 3000, 2000][index], ata: recipientAccounts[index].address.toBase58() })),
  }, null, 2));
} else if (process.argv[2] === "pay") {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);
  const splitId = new anchor.BN(Date.now());
  const splitConfig = PublicKey.findProgramAddressSync([
    Buffer.from("split"), payer.publicKey.toBuffer(), splitId.toArrayLike(Buffer, "le", 8),
  ], programId)[0];
  const create = program.methods.createSplit(splitId, recipients, [5000, 3000, 2000]).accountsPartial({
    creator: payer.publicKey, mint, splitConfig,
  });
  await create.simulate();
  const createSignature = await create.rpc();
  const payerAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  const recipientAccounts = await Promise.all(recipients.map((recipient) =>
    getOrCreateAssociatedTokenAccount(connection, payer, mint, recipient, true),
  ));
  const before = await Promise.all(recipientAccounts.map((account) => getAccount(connection, account.address)));
  const payerBefore = (await getAccount(connection, payerAccount.address)).amount;
  const pay = program.methods.executeSplit(new anchor.BN(10_000_000)).accountsPartial({
    payer: payer.publicKey, splitConfig, mint, payerTokenAccount: payerAccount.address,
  }).remainingAccounts(recipientAccounts.map((account) => ({
    pubkey: account.address, isWritable: true, isSigner: false,
  })));
  const simulation = await pay.simulate();
  console.log("Devnet payment simulation passed.");
  assert(simulation.raw.some((line: string) => line.includes("ExecuteSplit")));
  const signature = await pay.rpc();
  const after = await Promise.all(recipientAccounts.map((account) => getAccount(connection, account.address)));
  const deltas = after.map((account, index) => account.amount - before[index].amount);
  assert.deepEqual(deltas, [5_000_000n, 3_000_000n, 2_000_000n]);
  assert.equal(payerBefore - (await getAccount(connection, payerAccount.address)).amount, 10_000_000n);
  const transaction = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  assert(transaction && !transaction.meta?.err);
  assert.equal(transaction.transaction.message.header.numRequiredSignatures, 1);
  console.log(JSON.stringify({ program: programId.toBase58(), mint: mint.toBase58(),
    splitConfig: splitConfig.toBase58(), createSignature, paymentSignature: signature,
    payer: payer.publicKey.toBase58(), recipientDeltas: deltas.map(String),
    recipientBalances: after.map((account) => account.amount.toString()),
    explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
  }, null, 2));
} else {
  throw new Error("Use setup or pay. This script targets devnet only.");
}
