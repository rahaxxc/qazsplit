use anchor_lang::prelude::*;

use crate::constants::MAX_RECIPIENTS;

#[account]
#[derive(InitSpace)]
pub struct SplitConfig {
    pub version: u8,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub split_id: u64,
    pub recipient_count: u8,
    pub recipients: [Pubkey; MAX_RECIPIENTS],
    pub shares_bps: [u16; MAX_RECIPIENTS],
    pub bump: u8,
}

