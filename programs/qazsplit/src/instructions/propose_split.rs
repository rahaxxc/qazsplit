use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{
    constants::*,
    errors::QazSplitError,
    state::{Milestone, SplitAgreement},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MilestoneInput {
    pub name: String,
    pub amount: u64,
}

#[derive(Accounts)]
#[instruction(split_id: u64)]
pub struct ProposeSplit<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(constraint = mint.decimals == 6 @ QazSplitError::InvalidMintDecimals)]
    pub mint: Account<'info, Mint>,
    #[account(init, payer = creator, space = 8 + SplitAgreement::INIT_SPACE,
        seeds = [AGREEMENT_SEED, creator.key().as_ref(), &split_id.to_le_bytes()], bump)]
    pub agreement: Account<'info, SplitAgreement>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ProposeSplit>,
    split_id: u64,
    recipients: Vec<Pubkey>,
    shares_bps: Vec<u16>,
    milestones: Vec<MilestoneInput>,
) -> Result<()> {
    let count = recipients.len();
    require!(
        (MIN_RECIPIENTS..=MAX_RECIPIENTS).contains(&count),
        QazSplitError::InvalidRecipientCount
    );
    require_eq!(
        count,
        shares_bps.len(),
        QazSplitError::RecipientShareLengthMismatch
    );
    let mut total = 0u16;
    for (index, share) in shares_bps.iter().enumerate() {
        require!(*share > 0, QazSplitError::ZeroShare);
        require!(
            !recipients[..index].contains(&recipients[index]),
            QazSplitError::DuplicateRecipient
        );
        total = total
            .checked_add(*share)
            .ok_or(QazSplitError::ArithmeticOverflow)?;
    }
    require_eq!(total, TOTAL_BASIS_POINTS, QazSplitError::InvalidShareTotal);
    require!(
        (1..=MAX_MILESTONES).contains(&milestones.len()),
        QazSplitError::InvalidMilestoneCount
    );

    let agreement = &mut ctx.accounts.agreement;
    agreement.version = SPLIT_CONFIG_VERSION;
    agreement.creator = ctx.accounts.creator.key();
    agreement.mint = ctx.accounts.mint.key();
    agreement.split_id = split_id;
    agreement.recipient_count = count as u8; // bounded by MAX_RECIPIENTS = 5
    agreement.recipients = [Pubkey::default(); MAX_RECIPIENTS];
    agreement.recipients[..count].copy_from_slice(&recipients);
    agreement.shares_bps = [0; MAX_RECIPIENTS];
    agreement.shares_bps[..count].copy_from_slice(&shares_bps);
    agreement.bump = ctx.bumps.agreement;
    agreement.approval_mask = 0;
    agreement.milestone_count = milestones.len() as u8; // bounded by MAX_MILESTONES = 5
    agreement.milestones = [Milestone::default(); MAX_MILESTONES];
    for (stored, input) in agreement.milestones.iter_mut().zip(milestones) {
        let bytes = input.name.as_bytes();
        require!(
            !input.name.trim().is_empty() && bytes.len() <= MAX_MILESTONE_NAME,
            QazSplitError::InvalidMilestoneName
        );
        require!(input.amount > 0, QazSplitError::ZeroAmount);
        stored.name_len = bytes.len() as u8; // at most 32 bytes
        stored.name[..bytes.len()].copy_from_slice(bytes);
        stored.amount = input.amount;
    }
    emit!(SplitProposed {
        agreement: agreement.key(),
        creator: agreement.creator
    });
    Ok(())
}

#[event]
pub struct SplitProposed {
    pub agreement: Pubkey,
    pub creator: Pubkey,
}
