use anchor_lang::prelude::*;
use crate::state::{VaultConfig, ExecutionLog, AssetPlan};
use crate::errors::VaultError;
use crate::constants::{full_mask_u32, full_mask_u64};

/// Permissionless. Marks the vault executed once the SOL mask is full and (if a
/// plan exists) every specific bequest is paid. Token residual shares may still
/// run afterwards — they gate only on `token_dist` existing (P4).
#[derive(Accounts)]
pub struct FinalizeExecution<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault_config.owner.as_ref()],
        bump = vault_config.bump,
        constraint = !vault_config.executed @ VaultError::ExecutionFinalized,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        mut,
        seeds = [b"execution", vault_config.key().as_ref()],
        bump = execution_log.bump,
        constraint = execution_log.vault == vault_config.key() @ VaultError::HeartbeatVaultMismatch,
    )]
    pub execution_log: Account<'info, ExecutionLog>,

    /// Required iff `vault_config.has_asset_plan` (P11 — omitted otherwise).
    #[account(
        seeds = [b"asset_plan", vault_config.key().as_ref()],
        bump,
    )]
    pub asset_plan: Option<Account<'info, AssetPlan>>,
}

pub fn handler(ctx: Context<FinalizeExecution>) -> Result<()> {
    let vault = &ctx.accounts.vault_config;
    let log = &ctx.accounts.execution_log;

    require!(
        log.sol_paid_mask == full_mask_u32(vault.beneficiaries.len()),
        VaultError::NotAllSharesPaid
    );

    if vault.has_asset_plan {
        let plan = ctx
            .accounts
            .asset_plan
            .as_ref()
            .ok_or(error!(VaultError::AssetPlanRequired))?;
        require!(plan.vault == vault.key(), VaultError::AssetPlanRequired);
        require!(
            plan.paid_mask == full_mask_u64(plan.assignments.len()),
            VaultError::NotAllSharesPaid
        );
    }

    ctx.accounts.vault_config.executed = true;
    ctx.accounts.vault_config.active = false;
    ctx.accounts.execution_log.completed = true;

    Ok(())
}
