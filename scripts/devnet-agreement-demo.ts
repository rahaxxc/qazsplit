// Bounded operational verifier. Existing devnet signers stay outside the repository.
// No personal wallet, mainnet URL, new wallet generation, or secret logging.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { getAccount, getMint, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";

const execute = process.argv.includes("--execute");
const directory = process.env.QAZSPLIT_DEVNET_KEY_DIR;
assert(directory && isAbsolute(directory), "Set the existing external devnet signer directory.");
const expected = [
  "4pnW63g4sqPgTJvBeEzaeC1Hx8eKSpxVzEPonBGfUmna", "HnmuWE9QzLTod7jywqDKEXdDPms3SjQnGBoBea6FjaEQ",
  "aXCZBKwKMSiDkftZd3m6Gky7FAsNpTnXA2yN9bP35JX", "FDFuduBsUvAqHEEiCAPxi3xWgb93cBPYu2SiMd9j41S8", "35DNGoyZwszHc2wVw6rhbUB68P8hVk9JCyvxhbtTZoUq",
];
const keys = await Promise.all(["deployer", "payer", "recipient-0", "recipient-1", "recipient-2"].map(async (role, i) => {
  const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(directory, `${role}.json`), "utf8"))));
  assert.equal(key.publicKey.toBase58(), expected[i], "External signer does not match this bounded demo."); return key;
}));
const [deployer, payer, ...recipients] = keys;
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
assert.equal(await connection.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
const programId = new PublicKey("3zqHQ8gWY2o8ZtfaGZg5JvgntkV6Qdf9zKBrJqufhKJD");
const mint = new PublicKey("7S3HyHeoD9WvVt63frsvRU9Kcixw2bRDAeyD8tVC6w8H");
assert.equal((await getMint(connection, mint)).decimals, 6);
const idl = JSON.parse(await readFile(new URL("../target/idl/qazsplit.json", import.meta.url), "utf8"));
assert.equal(idl.address, programId.toBase58());
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(deployer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const splitId = new anchor.BN("202610100001");
const agreement = PublicKey.findProgramAddressSync([Buffer.from("agreement"), deployer.publicKey.toBuffer(), splitId.toArrayLike(Buffer, "le", 8)], programId)[0];
const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
const recipientAtas = recipients.map((r) => getAssociatedTokenAddressSync(mint, r.publicKey));
const amount = 10_000_000n;
const milestones = [{ name: "Design", amount: new anchor.BN(amount.toString()) }, { name: "Development", amount: new anchor.BN(20_000_000) }, { name: "Launch", amount: new anchor.BN(10_000_000) }];
const proof: Record<string, unknown> = { cluster: "devnet", program: programId.toBase58(), mint: mint.toBase58(), agreement: agreement.toBase58(), payer: payer.publicKey.toBase58(), amount: "10 mock USDC" };
async function state() { return program.account.splitAgreement.fetch(agreement); }
async function send(label: string, instructions: TransactionInstruction[], signer: Keypair) {
  const latest = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: latest.blockhash }).add(...instructions);
  const simulation = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: "confirmed" });
  assert.equal(simulation.value.err, null, `${label} simulation failed: ${JSON.stringify(simulation.value.err)} ${simulation.value.logs?.join(" | ")}`);
  console.log(JSON.stringify({ action: label, simulation: "passed", feePayer: signer.publicKey.toBase58(), execute }));
  if (!execute) throw new Error("Read-only plan: rerun with --execute only after scoped authorization.");
  const sig = await sendAndConfirmTransaction(connection, tx, [signer], { commitment: "confirmed", preflightCommitment: "confirmed" });
  proof[label] = sig; return sig;
}
assert((await getAccount(connection, payerAta)).amount >= amount, "Dedicated demo payer needs 10 mock USDC; no minting is performed by this script.");
if (!execute) {
  console.log(JSON.stringify({ ...proof, recipients: expected.slice(2), fundingCapLamports: 1_980_000, recipientAllocationRaw: ["5000000","3000000","2000000"], execute: false }, null, 2));
  process.exit(0);
}
const funding: TransactionInstruction[] = [];
const minimum = await connection.getMinimumBalanceForRentExemption(0);
assert(minimum + 5_000 <= 660_000, "Rent changed; review funding cap before executing.");
for (const recipient of recipients) {
  const balance = await connection.getBalance(recipient.publicKey);
  if (balance < 660_000) funding.push(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: recipient.publicKey, lamports: 660_000 - balance }));
}
if (funding.length) await send("recipientFundingSignature", funding, deployer);
if (!(await connection.getAccountInfo(agreement))) {
  const ix = await program.methods.proposeSplit(splitId, recipients.map((r) => r.publicKey), [5000,3000,2000], milestones).accountsPartial({ creator: deployer.publicKey, mint, agreement }).instruction();
  await send("proposalSignature", [ix], deployer);
}
let stored = await state();
assert.deepEqual(stored.recipients.slice(0,3).map((r: PublicKey) => r.toBase58()), expected.slice(2));
assert.deepEqual(stored.sharesBps.slice(0,3), [5000,3000,2000]);
assert.equal(stored.milestones[0].amount.toString(), amount.toString());
const approvals: string[] = [];
for (let i = 0; i < recipients.length; i++) {
  if ((stored.approvalMask & (1 << i)) === 0) {
    const ix = await program.methods.approveSplit().accountsPartial({ recipient: recipients[i].publicKey, agreement }).instruction();
    approvals.push(await send(`approval${i + 1}Signature`, [ix], recipients[i]));
    stored = await state(); assert.equal(stored.approvalMask & (1 << i), 1 << i);
    console.log(JSON.stringify({ approved: i + 1, total: 3, active: stored.approvalMask === 7 }));
  }
}
assert.equal(stored.approvalMask, 7);
if (stored.milestones[0].paid) {
  console.log(JSON.stringify({ ...proof, status: "Design already paid; no repeat payment sent", paidSlot: stored.milestones[0].paidSlot.toString() }, null, 2)); process.exit(0);
}
const before = await Promise.all(recipientAtas.map((a) => getAccount(connection, a)));
const payerBefore = (await getAccount(connection, payerAta)).amount;
const createAtas = recipientAtas.map((a,i) => createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, a, recipients[i].publicKey, mint));
const payIx = await program.methods.payMilestone(0).accountsPartial({ payer: payer.publicKey, agreement, mint, payerTokenAccount: payerAta }).remainingAccounts(recipientAtas.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }))).instruction();
const paymentSignature = await send("paymentSignature", [...createAtas, payIx], payer);
const after = await Promise.all(recipientAtas.map((a) => getAccount(connection, a)));
const deltas = after.map((a,i) => a.amount - before[i].amount);
assert.deepEqual(deltas, [5_000_000n,3_000_000n,2_000_000n]);
assert.equal(payerBefore - (await getAccount(connection, payerAta)).amount, amount);
stored = await state(); assert(stored.milestones[0].paid); assert.equal(stored.milestones[0].payer.toBase58(), payer.publicKey.toBase58());
const tx = await connection.getTransaction(paymentSignature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
assert(tx && tx.meta && !tx.meta.err); assert.equal(tx.transaction.message.header.numRequiredSignatures, 1);
assert.equal(tx.meta.innerInstructions?.flatMap((i) => i.instructions).filter((i) => "data" in i).length, 3);
console.log(JSON.stringify({ ...proof, approvalMask: stored.approvalMask, milestone: "Design", status: "Paid", recipientDeltasRaw: deltas.map(String), recipientBalancesRaw: after.map((a) => a.amount.toString()), paidAt: stored.milestones[0].paidAt.toString(), paidSlot: stored.milestones[0].paidSlot.toString(), explorer: `https://explorer.solana.com/tx/${paymentSignature}?cluster=devnet` }, null, 2));
