use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, AssetPlan, AssetAssignment};
use crate::errors::VaultError;
use crate::util::deadline;
use crate::instructions::set_asset_plan::validate_assignments;

/// Owner overwrite of an existing AssetPlan buffer. Same guards as set_asset_plan;
/// kept separate from `init` rather than using `init_if_needed`.
#[derive(Accounts)]
pub struct UpdateAssetPlan<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
        constraint = vault_config.active @ VaultError::VaultInactive,
        constraint = !vault_config.executed @ VaultError::VaultAlreadyExecuted,
        constraint = vault_config.has_asset_plan @ VaultError::AssetPlanRequired,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        seeds = [b"heartbeat", vault_config.key().as_ref()],
        bump = heartbeat_record.bump,
        constraint = heartbeat_record.vault == vault_config.key() @ VaultError::HeartbeatVaultMismatch,
    )]
    pub heartbeat_record: Account<'info, HeartbeatRecord>,

    #[account(
        mut,
        seeds = [b"asset_plan", vault_config.key().as_ref()],
        bump = asset_plan.bump,
        constraint = asset_plan.vault == vault_config.key() @ VaultError::AssetPlanRequired,
    )]
    pub asset_plan: Account<'info, AssetPlan>,
}

pub fn handler(ctx: Context<UpdateAssetPlan>, assignments: Vec<AssetAssignment>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault = &ctx.accounts.vault_config;
    let hb = &ctx.accounts.heartbeat_record;

    let dl = deadline(hb.last_heartbeat, vault.heartbeat_interval, vault.grace_period)?;
    require!(now < dl, VaultError::AssetPlanImmutable);

    validate_assignments(&assignments, vault.beneficiaries.len())?;

    let plan = &mut ctx.accounts.asset_plan;
    plan.assignments = assignments;
    plan.paid_mask = 0;

    Ok(())
}
