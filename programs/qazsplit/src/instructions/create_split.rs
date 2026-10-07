use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::{
    constants::{
        MAX_RECIPIENTS, MIN_RECIPIENTS, SPLIT_CONFIG_VERSION, SPLIT_SEED,
        TOTAL_BASIS_POINTS,
    },
    errors::QazSplitError,
    state::SplitConfig,
};

#[derive(Accounts)]
#[instruction(split_id: u64)]
pub struct CreateSplit<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = creator,
        space = 8 + SplitConfig::INIT_SPACE,
        seeds = [SPLIT_SEED, creator.key().as_ref(), &split_id.to_le_bytes()],
        bump
    )]
    pub split_config: Account<'info, SplitConfig>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateSplit>,
    split_id: u64,
    recipients: Vec<Pubkey>,
    shares_bps: Vec<u16>,
) -> Result<()> {
    require!(
        (MIN_RECIPIENTS..=MAX_RECIPIENTS).contains(&recipients.len()),
        QazSplitError::InvalidRecipientCount
    );
    require_eq!(
        recipients.len(),
        shares_bps.len(),
        QazSplitError::RecipientShareLengthMismatch
    );
    require!(
        shares_bps.iter().all(|share| *share > 0),
        QazSplitError::ZeroShare
    );

    let total = shares_bps
        .iter()
        .try_fold(0u16, |sum, share| sum.checked_add(*share))
        .ok_or(QazSplitError::ArithmeticOverflow)?;
    require_eq!(total, TOTAL_BASIS_POINTS, QazSplitError::InvalidShareTotal);

    for (index, recipient) in recipients.iter().enumerate() {
        require!(
            !recipients[index + 1..].contains(recipient),
            QazSplitError::DuplicateRecipient
        );
    }

    let mut stored_recipients = [Pubkey::default(); MAX_RECIPIENTS];
    let mut stored_shares = [0u16; MAX_RECIPIENTS];
    stored_recipients[..recipients.len()].copy_from_slice(&recipients);
    stored_shares[..shares_bps.len()].copy_from_slice(&shares_bps);

    let config = &mut ctx.accounts.split_config;
    config.version = SPLIT_CONFIG_VERSION;
    config.creator = ctx.accounts.creator.key();
    config.mint = ctx.accounts.mint.key();
    config.split_id = split_id;
    config.recipient_count = u8::try_from(recipients.len())
        .map_err(|_| QazSplitError::InvalidRecipientCount)?;
    config.recipients = stored_recipients;
    config.shares_bps = stored_shares;
    config.bump = ctx.bumps.split_config;

    emit!(SplitCreated {
        split_config: config.key(),
        creator: config.creator,
        mint: config.mint,
        split_id,
        recipient_count: config.recipient_count,
    });

    Ok(())
}

#[event]
pub struct SplitCreated {
    pub split_config: Pubkey,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub split_id: u64,
    pub recipient_count: u8,
}

