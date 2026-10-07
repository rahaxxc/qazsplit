import * as anchor from "@anchor-lang/core";
import {
  createMint,
  freezeAccount,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  thawAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

import type { Qazsplit } from "../target/types/qazsplit";

describe("qazsplit", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Qazsplit as anchor.Program<Qazsplit>;
  const payer = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;

  const shares = [5_000, 3_000, 2_000];
  const recipients = [0, 1, 2].map(
    (index) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("qazsplit-recipient"), Buffer.from([index])],
        program.programId,
      )[0],
  );

  let mint: PublicKey;
  let payerAta: PublicKey;
  let recipientAtas: PublicKey[];
  let splitConfig: PublicKey;

  function splitPda(splitId: anchor.BN, creator = provider.wallet.publicKey) {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("split"),
        creator.toBuffer(),
        splitId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    )[0];
  }

  async function expectFailure(action: Promise<unknown>) {
    let failed = false;
    try {
      await action;
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
  }

  async function balances() {
    return Promise.all(recipientAtas.map(async (ata) => (await getAccount(provider.connection, ata)).amount));
  }

  before(async () => {
    mint = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      provider.wallet.publicKey,
      6,
    );
    payerAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        mint,
        provider.wallet.publicKey,
      )
    ).address;
    recipientAtas = await Promise.all(
      recipients.map(async (recipient) =>
        (
          await getOrCreateAssociatedTokenAccount(
            provider.connection,
            payer,
            mint,
            recipient,
            true,
          )
        ).address,
      ),
    );
    await mintTo(
      provider.connection,
      payer,
      mint,
      payerAta,
      provider.wallet.publicKey,
      1_000_000_000n,
    );
  });

  it("creates an immutable 50/30/20 config", async () => {
    const splitId = new anchor.BN(1);
    splitConfig = splitPda(splitId);
    await program.methods
      .createSplit(splitId, recipients, shares)
      .accountsPartial({
        creator: provider.wallet.publicKey,
        mint,
        splitConfig,
      })
      .rpc();

    const stored = await program.account.splitConfig.fetch(splitConfig);
    expect(stored.creator.equals(provider.wallet.publicKey)).to.equal(true);
    expect(stored.mint.equals(mint)).to.equal(true);
    expect(stored.recipientCount).to.equal(3);
    expect(stored.sharesBps.slice(0, 3)).to.deep.equal(shares);
  });

  it("rejects percentages that do not total 100%", async () => {
    const splitId = new anchor.BN(2);
    await expectFailure(
      program.methods
        .createSplit(splitId, recipients, [5_000, 3_000, 1_999])
        .accountsPartial({
          creator: provider.wallet.publicKey,
          mint,
          splitConfig: splitPda(splitId),
        })
        .rpc(),
    );
  });

  it("rejects duplicate recipients", async () => {
    const splitId = new anchor.BN(3);
    await expectFailure(
      program.methods
        .createSplit(splitId, [recipients[0], recipients[0]], [5_000, 5_000])
        .accountsPartial({
          creator: provider.wallet.publicKey,
          mint,
          splitConfig: splitPda(splitId),
        })
        .rpc(),
    );
  });

  it("rejects a wrong token mint", async () => {
    const wrongMint = await createMint(
      provider.connection,
      payer,
      provider.wallet.publicKey,
      null,
      6,
    );
    const wrongPayerAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        wrongMint,
        provider.wallet.publicKey,
      )
    ).address;

    await expectFailure(
      program.methods
        .executeSplit(new anchor.BN(1_000_000))
        .accountsPartial({
          payer: provider.wallet.publicKey,
          splitConfig,
          mint: wrongMint,
          payerTokenAccount: wrongPayerAta,
        })
        .remainingAccounts(recipientAtas.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })))
        .rpc(),
    );
  });

  it("executes a valid 50/30/20 split", async () => {
    const before = await balances();
    await program.methods
      .executeSplit(new anchor.BN(10_000_000))
      .accountsPartial({
        payer: provider.wallet.publicKey,
        splitConfig,
        mint,
        payerTokenAccount: payerAta,
      })
      .remainingAccounts(recipientAtas.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })))
      .rpc();
    const after = await balances();
    expect(after.map((value, index) => value - before[index])).to.deep.equal([
      5_000_000n,
      3_000_000n,
      2_000_000n,
    ]);
  });

  it("assigns the rounding remainder to the final recipient", async () => {
    const before = await balances();
    await program.methods
      .executeSplit(new anchor.BN(10_000_001))
      .accountsPartial({
        payer: provider.wallet.publicKey,
        splitConfig,
        mint,
        payerTokenAccount: payerAta,
      })
      .remainingAccounts(recipientAtas.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })))
      .rpc();
    const after = await balances();
    expect(after.map((value, index) => value - before[index])).to.deep.equal([
      5_000_000n,
      3_000_000n,
      2_000_001n,
    ]);
  });

  it("fails with insufficient balance and rolls back every transfer", async () => {
    const payerBefore = (await getAccount(provider.connection, payerAta)).amount;
    const recipientsBefore = await balances();
    await expectFailure(
      program.methods
        .executeSplit(new anchor.BN(2_000_000_000))
        .accountsPartial({
          payer: provider.wallet.publicKey,
          splitConfig,
          mint,
          payerTokenAccount: payerAta,
        })
        .remainingAccounts(recipientAtas.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })))
        .rpc(),
    );
    expect((await getAccount(provider.connection, payerAta)).amount).to.equal(payerBefore);
    expect(await balances()).to.deep.equal(recipientsBefore);
  });

  it("rolls back earlier CPIs when a later transfer fails", async () => {
    await freezeAccount(
      provider.connection,
      payer,
      recipientAtas[2],
      mint,
      provider.wallet.publicKey,
    );
    const payerBefore = (await getAccount(provider.connection, payerAta)).amount;
    const recipientsBefore = await balances();

    await expectFailure(
      program.methods
        .executeSplit(new anchor.BN(1_000_000))
        .accountsPartial({
          payer: provider.wallet.publicKey,
          splitConfig,
          mint,
          payerTokenAccount: payerAta,
        })
        .remainingAccounts(recipientAtas.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false })))
        .rpc(),
    );

    expect((await getAccount(provider.connection, payerAta)).amount).to.equal(payerBefore);
    expect(await balances()).to.deep.equal(recipientsBefore);
    await thawAccount(
      provider.connection,
      payer,
      recipientAtas[2],
      mint,
      provider.wallet.publicKey,
    );
  });

  it("does not allow another signer to mutate the existing config", async () => {
    const before = await program.account.splitConfig.fetch(splitConfig);
    const unauthorizedCreator = Keypair.generate();

    await expectFailure(
      program.methods
        .createSplit(new anchor.BN(1), recipients, shares)
        .accountsPartial({
          creator: unauthorizedCreator.publicKey,
          mint,
          splitConfig,
        })
        .signers([unauthorizedCreator])
        .rpc(),
    );

    const after = await program.account.splitConfig.fetch(splitConfig);
    expect(after.creator.equals(before.creator)).to.equal(true);
    expect(after.mint.equals(before.mint)).to.equal(true);
    expect(after.sharesBps).to.deep.equal(before.sharesBps);
  });
});

