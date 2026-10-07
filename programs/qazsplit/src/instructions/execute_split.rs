use anchor_lang::prelude::*;
use anchor_spl::token::{self, transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::SPLIT_SEED,
    errors::QazSplitError,
    math::calculate_allocations,
    state::SplitConfig,
};

#[derive(Accounts)]
pub struct ExecuteSplit<'info> {
    pub payer: Signer<'info>,
    #[account(
        seeds = [
            SPLIT_SEED,
            split_config.creator.as_ref(),
            &split_config.split_id.to_le_bytes()
        ],
        bump = split_config.bump,
        has_one = mint @ QazSplitError::WrongMint
    )]
    pub split_config: Account<'info, SplitConfig>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = payer
    )]
    pub payer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handler<'info>(
    ctx: Context<'info, ExecuteSplit<'info>>,
    amount: u64,
) -> Result<()> {
    let config = &ctx.accounts.split_config;
    let recipient_count = usize::from(config.recipient_count);
    require_eq!(
        ctx.remaining_accounts.len(),
        recipient_count,
        QazSplitError::InvalidRecipientAccountCount
    );

    for (index, account_info) in ctx.remaining_accounts.iter().enumerate() {
        require!(
            account_info.is_writable,
            QazSplitError::RecipientAccountNotWritable
        );
        require_keys_eq!(
            *account_info.owner,
            token::ID,
            QazSplitError::InvalidTokenAccountProgram
        );

        let recipient_token = Account::<TokenAccount>::try_from(account_info)?;
        require_keys_eq!(
            recipient_token.mint,
            config.mint,
            QazSplitError::RecipientMintMismatch
        );
        require_keys_eq!(
            recipient_token.owner,
            config.recipients[index],
            QazSplitError::RecipientOwnerMismatch
        );
    }

    let allocations = calculate_allocations(amount, &config.shares_bps[..recipient_count])?;

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

    emit!(SplitExecuted {
        split_config: config.key(),
        payer: ctx.accounts.payer.key(),
        mint: config.mint,
        amount,
    });

    Ok(())
}

#[event]
pub struct SplitExecuted {
    pub split_config: Pubkey,
    pub payer: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

