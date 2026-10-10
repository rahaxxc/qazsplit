use crate::{
    constants::AGREEMENT_SEED, errors::QazSplitError, math::calculate_allocations,
    state::SplitAgreement,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, transfer_checked, Mint, Token, TokenAccount, TransferChecked};

#[derive(Accounts)]
pub struct PayMilestone<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [AGREEMENT_SEED, agreement.creator.as_ref(), &agreement.split_id.to_le_bytes()],
        bump = agreement.bump, has_one = mint @ QazSplitError::WrongMint)]
    pub agreement: Account<'info, SplitAgreement>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = payer)]
    pub payer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handler<'info>(ctx: Context<'info, PayMilestone<'info>>, milestone_index: u8) -> Result<()> {
    let agreement = &mut ctx.accounts.agreement;
    require!(agreement.is_active(), QazSplitError::AgreementPending);
    let index = usize::from(milestone_index);
    require!(
        index < usize::from(agreement.milestone_count),
        QazSplitError::InvalidMilestoneIndex
    );
    require!(
        !agreement.milestones[index].paid,
        QazSplitError::MilestoneAlreadyPaid
    );
    let count = usize::from(agreement.recipient_count);
    require_eq!(
        ctx.remaining_accounts.len(),
        count,
        QazSplitError::InvalidRecipientAccountCount
    );
    for (recipient_index, account_info) in ctx.remaining_accounts.iter().enumerate() {
        require!(
            account_info.is_writable,
            QazSplitError::RecipientAccountNotWritable
        );
        require_keys_eq!(
            *account_info.owner,
            token::ID,
            QazSplitError::InvalidTokenAccountProgram
        );
        let token = Account::<TokenAccount>::try_from(account_info)?;
        require_keys_eq!(
            token.mint,
            agreement.mint,
            QazSplitError::RecipientMintMismatch
        );
        require_keys_eq!(
            token.owner,
            agreement.recipients[recipient_index],
            QazSplitError::RecipientOwnerMismatch
        );
    }
    let amount = agreement.milestones[index].amount;
    let allocations = calculate_allocations(amount, &agreement.shares_bps[..count])?;
    // The payer authorizes each direct SPL Token CPI. No PDA holds or delegates funds.
    for (account_info, allocation) in ctx.remaining_accounts.iter().zip(allocations.iter()) {
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.payer_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: account_info.clone(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            *allocation,
            ctx.accounts.mint.decimals,
        )?;
    }
    // State and ALL CPIs commit together; a failed transfer leaves the milestone unpaid.
    let clock = Clock::get()?;
    let milestone = &mut agreement.milestones[index];
    milestone.paid = true;
    milestone.payer = ctx.accounts.payer.key();
    milestone.paid_at = clock.unix_timestamp;
    milestone.paid_slot = clock.slot;
    emit!(MilestonePaid {
        agreement: agreement.key(),
        milestone_index,
        payer: ctx.accounts.payer.key(),
        amount,
        paid_at: clock.unix_timestamp
    });
    Ok(())
}

#[event]
pub struct MilestonePaid {
    pub agreement: Pubkey,
    pub milestone_index: u8,
    pub payer: Pubkey,
    pub amount: u64,
    pub paid_at: i64,
}
