use anchor_lang::prelude::*;

use crate::constants::{MAX_MILESTONES, MAX_MILESTONE_NAME, MAX_RECIPIENTS};

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

// Separate discriminator and seeds keep all legacy SplitConfig accounts compatible.
// Terms have no update instruction. Only approval/payment records are mutable.
#[account]
#[derive(InitSpace)]
pub struct SplitAgreement {
    pub version: u8,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub split_id: u64,
    pub recipient_count: u8,
    pub recipients: [Pubkey; MAX_RECIPIENTS],
    pub shares_bps: [u16; MAX_RECIPIENTS],
    pub bump: u8,
    pub approval_mask: u8,
    pub milestone_count: u8,
    pub milestones: [Milestone; MAX_MILESTONES],
}

impl SplitAgreement {
    pub fn is_active(&self) -> bool {
        self.approval_mask == (1u8 << self.recipient_count) - 1
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Milestone {
    pub name_len: u8,
    pub name: [u8; MAX_MILESTONE_NAME],
    pub amount: u64,
    pub paid: bool,
    pub payer: Pubkey,
    pub paid_at: i64,
    pub paid_slot: u64,
}
