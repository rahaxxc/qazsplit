use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("3zqHQ8gWY2o8ZtfaGZg5JvgntkV6Qdf9zKBrJqufhKJD");

#[program]
pub mod qazsplit {
    use super::*;

    pub fn propose_split(
        ctx: Context<ProposeSplit>,
        split_id: u64,
        recipients: Vec<Pubkey>,
        shares_bps: Vec<u16>,
        milestones: Vec<MilestoneInput>,
    ) -> Result<()> {
        propose_split::handler(ctx, split_id, recipients, shares_bps, milestones)
    }

    pub fn approve_split(ctx: Context<ApproveSplit>) -> Result<()> {
        approve_split::handler(ctx)
    }

    pub fn pay_milestone<'info>(
        ctx: Context<'info, PayMilestone<'info>>,
        milestone_index: u8,
    ) -> Result<()> {
        pay_milestone::handler(ctx, milestone_index)
    }

    pub fn create_split(
        ctx: Context<CreateSplit>,
        split_id: u64,
        recipients: Vec<Pubkey>,
        shares_bps: Vec<u16>,
    ) -> Result<()> {
        create_split::handler(ctx, split_id, recipients, shares_bps)
    }

    pub fn execute_split<'info>(
        ctx: Context<'info, ExecuteSplit<'info>>,
        amount: u64,
    ) -> Result<()> {
        execute_split::handler(ctx, amount)
    }
}
