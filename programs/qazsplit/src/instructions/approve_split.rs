use crate::{constants::AGREEMENT_SEED, errors::QazSplitError, state::SplitAgreement};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ApproveSplit<'info> {
    pub recipient: Signer<'info>,
    #[account(mut, seeds = [AGREEMENT_SEED, agreement.creator.as_ref(), &agreement.split_id.to_le_bytes()], bump = agreement.bump)]
    pub agreement: Account<'info, SplitAgreement>,
}

pub fn handler(ctx: Context<ApproveSplit>) -> Result<()> {
    let agreement = &mut ctx.accounts.agreement;
    let index = agreement.recipients[..usize::from(agreement.recipient_count)]
        .iter()
        .position(|key| *key == ctx.accounts.recipient.key())
        .ok_or(QazSplitError::UnauthorizedRecipient)?;
    let bit = 1u8 << index;
    require!(
        agreement.approval_mask & bit == 0,
        QazSplitError::AlreadyApproved
    );
    agreement.approval_mask |= bit;
    emit!(SplitApproved {
        agreement: agreement.key(),
        recipient: ctx.accounts.recipient.key(),
        active: agreement.is_active()
    });
    Ok(())
}

#[event]
pub struct SplitApproved {
    pub agreement: Pubkey,
    pub recipient: Pubkey,
    pub active: bool,
}
