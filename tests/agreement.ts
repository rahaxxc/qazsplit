import * as anchor from "@anchor-lang/core";
import { createMint, freezeAccount, getAccount, getOrCreateAssociatedTokenAccount, mintTo, thawAccount } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import type { Qazsplit } from "../target/types/qazsplit";

describe("recipient-approved milestone agreement", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Qazsplit as anchor.Program<Qazsplit>;
  const payer = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;
  const members = Array.from({ length: 3 }, () => Keypair.generate());
  const recipients = members.map((member) => member.publicKey);
  const shares = [5000, 3000, 2000];
  const milestones = [
    { name: "Design", amount: new anchor.BN(10_000_000) },
    { name: "Development", amount: new anchor.BN(10_000_001) },
    { name: "Launch", amount: new anchor.BN(2_000_000_000) },
  ];
  let mint: PublicKey;
  let payerAta: PublicKey;
  let atas: PublicKey[];
  let agreement: PublicKey;
  let nextId = 100;
  const remaining = () => atas.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false }));
  const pda = (id: anchor.BN) => PublicKey.findProgramAddressSync(
    [Buffer.from("agreement"), provider.wallet.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], program.programId,
  )[0];
  const state = () => program.account.splitAgreement.fetch(agreement);
  const balances = () => Promise.all([payerAta, ...atas].map(async (ata) => (await getAccount(provider.connection, ata)).amount));

  async function fails(action: Promise<unknown>, code?: string) {
    try { await action; } catch (error) {
      if (code) expect(String(error)).to.contain(code);
      return;
    }
    expect.fail("Expected transaction to fail");
  }
  function propose(id = new anchor.BN(nextId++), wallets = recipients, bps = shares, stages = milestones) {
    return program.methods.proposeSplit(id, wallets, bps, stages).accountsPartial({
      creator: provider.wallet.publicKey, mint, agreement: pda(id),
    });
  }
  function approve(member: Keypair) {
    return program.methods.approveSplit().accountsPartial({ recipient: member.publicKey, agreement }).signers([member]);
  }
  function pay(index: number, recipientAccounts = remaining()) {
    return program.methods.payMilestone(index).accountsPartial({
      payer: provider.wallet.publicKey, agreement, mint, payerTokenAccount: payerAta,
    }).remainingAccounts(recipientAccounts);
  }

  before(async () => {
    mint = await createMint(provider.connection, payer, payer.publicKey, payer.publicKey, 6);
    payerAta = (await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, payer.publicKey)).address;
    atas = await Promise.all(recipients.map(async (wallet) =>
      (await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, wallet)).address));
    await mintTo(provider.connection, payer, mint, payerAta, payer, 1_000_000_000n);
  });

  it("proposes immutable terms with zero approvals and all milestones unpaid", async () => {
    const id = new anchor.BN(nextId++);
    agreement = pda(id);
    await propose(id).rpc();
    const stored = await state();
    expect(stored.approvalMask).to.equal(0);
    expect(stored.recipientCount).to.equal(3);
    expect(stored.sharesBps.slice(0, 3)).to.deep.equal(shares);
    expect(stored.milestoneCount).to.equal(3);
    expect(stored.milestones.slice(0, 3).map((m) => m.paid)).to.deep.equal([false, false, false]);
  });
  it("rejects invalid totals, duplicates, zero shares, and recipient count", async () => {
    await fails(propose(undefined, recipients, [5000, 3000, 1999]).rpc(), "InvalidShareTotal");
    await fails(propose(undefined, [recipients[0], recipients[0]], [5000, 5000]).rpc(), "DuplicateRecipient");
    await fails(propose(undefined, recipients, [5000, 5000, 0]).rpc(), "ZeroShare");
    await fails(propose(undefined, recipients, [5000, 5000]).rpc(), "RecipientShareLengthMismatch");
    await fails(propose(undefined, [recipients[0]], [10000]).rpc(), "InvalidRecipientCount");
    await fails(propose(undefined, Array(6).fill(recipients[0]), Array(6).fill(1000)).rpc(), "InvalidRecipientCount");
  });
  it("accepts the 2- and 5-recipient boundaries with five fixed milestones", async () => {
    for (const count of [2, 5]) {
      const wallets = count === 2 ? recipients.slice(0, 2) : [...recipients, Keypair.generate().publicKey, Keypair.generate().publicKey];
      const id = new anchor.BN(nextId++);
      await propose(id, wallets, Array(count).fill(10000 / count), Array(5).fill(milestones[0])).rpc();
      const stored = await program.account.splitAgreement.fetch(pda(id));
      expect(stored.recipientCount).to.equal(count);
      expect(stored.milestoneCount).to.equal(5);
      expect((await provider.connection.getAccountInfo(pda(id)))!.data.length).to.equal(705);
    }
  });
  it("rejects missing/too many milestones, blank/oversize names, zero amounts, and non-six-decimal mints", async () => {
    await fails(propose(undefined, recipients, shares, []).rpc(), "InvalidMilestoneCount");
    await fails(propose(undefined, recipients, shares, Array(6).fill(milestones[0])).rpc(), "InvalidMilestoneCount");
    for (const name of ["", "   ", "x".repeat(33), "界".repeat(11)]) {
      await fails(propose(undefined, recipients, shares, [{ name, amount: new anchor.BN(1) }]).rpc(), "InvalidMilestoneName");
    }
    await fails(propose(undefined, recipients, shares, [{ name: "Zero", amount: new anchor.BN(0) }]).rpc(), "ZeroAmount");
    const wrongDecimals = await createMint(provider.connection, payer, payer.publicKey, null, 9);
    const id = new anchor.BN(nextId++);
    await fails(propose(id).accountsPartial({ mint: wrongDecimals }).rpc(), "InvalidMintDecimals");
  });
  it("rejects payment while Pending without changing balances or paid state", async () => {
    const before = await balances();
    await fails(pay(0).rpc(), "AgreementPending");
    expect(await balances()).to.deep.equal(before);
    expect((await state()).milestones[0].paid).to.equal(false);
  });
  it("rejects an unauthorized approving wallet", async () => {
    await fails(approve(Keypair.generate()).rpc(), "UnauthorizedRecipient");
    expect((await state()).approvalMask).to.equal(0);
  });
  it("requires the recipient's actual transaction signature", async () => {
    const ix = await program.methods.approveSplit().accountsPartial({ recipient: recipients[0], agreement }).instruction();
    for (const meta of ix.keys) if (meta.pubkey.equals(recipients[0])) meta.isSigner = false;
    await fails(provider.sendAndConfirm(new Transaction().add(ix)), "AccountNotSigner");
    expect((await state()).approvalMask).to.equal(0);
  });
  it("records each approval once and remains Pending at 2 of 3", async () => {
    await approve(members[0]).rpc();
    await fails(approve(members[0]).rpc(), "AlreadyApproved");
    await approve(members[1]).rpc();
    expect((await state()).approvalMask).to.equal(3);
    await fails(pay(0).rpc(), "AgreementPending");
  });
  it("activates only at all three approvals, without changing the terms", async () => {
    const before = await state();
    await approve(members[2]).rpc();
    const after = await state();
    expect(after.approvalMask).to.equal(7);
    expect(after.recipients).to.deep.equal(before.recipients);
    expect(after.sharesBps).to.deep.equal(before.sharesBps);
    expect(after.milestones).to.deep.equal(before.milestones);
    await fails(approve(members[2]).rpc(), "AlreadyApproved");
  });
  it("cannot reinitialize or mutate an agreement, even by its creator", async () => {
    const before = (await provider.connection.getAccountInfo(agreement))!.data;
    const stored = await state();
    await fails(propose(stored.splitId, recipients, [4000, 4000, 2000]).rpc());
    expect((await provider.connection.getAccountInfo(agreement))!.data).to.deep.equal(before);
  });
  it("cannot use the legacy payment instruction to bypass approvals or milestone tracking", async () => {
    await fails(program.methods.executeSplit(new anchor.BN(1)).accountsPartial({
      payer: payer.publicKey, splitConfig: agreement, mint, payerTokenAccount: payerAta,
    }).remainingAccounts(remaining()).rpc());
  });
  it("rejects invalid milestone indexes and wrong mint/recipient accounts", async () => {
    await fails(pay(3).rpc(), "InvalidMilestoneIndex");
    const otherMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    await fails(pay(0).accountsPartial({ mint: otherMint }).rpc(), "WrongMint");
    await fails(pay(0, remaining().reverse()).rpc(), "RecipientOwnerMismatch");
    await fails(pay(0, remaining().slice(1)).rpc(), "InvalidRecipientAccountCount");
    expect((await state()).milestones[0].paid).to.equal(false);
  });
  it("pays the fixed milestone amount atomically at 50/30/20 and records payment proof", async () => {
    const before = await balances();
    const signature = await pay(0).rpc();
    const after = await balances();
    expect(after.map((v, i) => v - before[i])).to.deep.equal([-10_000_000n, 5_000_000n, 3_000_000n, 2_000_000n]);
    const stored = await state();
    expect(stored.milestones[0].paid).to.equal(true);
    expect(stored.milestones[0].payer.equals(payer.publicKey)).to.equal(true);
    expect(stored.milestones[0].paidAt.toNumber()).to.be.greaterThan(0);
    expect(stored.milestones[0].paidSlot.toNumber()).to.be.greaterThan(0);
    expect(stored.milestones[1].paid).to.equal(false);
    let tx = await provider.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    for (let attempt = 0; !tx && attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      tx = await provider.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    }
    expect(tx, "confirmed payment must be indexed by the local RPC").not.to.equal(null);
    expect(tx!.transaction.message.header.numRequiredSignatures).to.equal(1);
  });
  it("prevents a second payment of the same milestone", async () => {
    const before = await balances();
    await fails(pay(0).rpc(), "MilestoneAlreadyPaid");
    expect(await balances()).to.deep.equal(before);
  });
  it("rolls back earlier transfers AND the milestone status if the final transfer fails", async () => {
    await freezeAccount(provider.connection, payer, atas[2], mint, payer);
    const before = await balances();
    await fails(pay(1).rpc({ skipPreflight: true }));
    expect(await balances()).to.deep.equal(before);
    const stored = await state();
    expect(stored.milestones[1].paid).to.equal(false);
    expect(stored.milestones[1].paidAt.toNumber()).to.equal(0);
    await thawAccount(provider.connection, payer, atas[2], mint, payer);
  });
  it("pays a separate milestone with exact rounding to the final recipient", async () => {
    const before = await balances();
    await pay(1).rpc();
    expect((await balances()).map((v, i) => v - before[i])).to.deep.equal([-10_000_001n, 5_000_000n, 3_000_000n, 2_000_001n]);
  });
  it("keeps an unaffordable milestone unpaid with every balance unchanged", async () => {
    const before = await balances();
    await fails(pay(2).rpc());
    expect(await balances()).to.deep.equal(before);
    expect((await state()).milestones[2].paid).to.equal(false);
  });
});
