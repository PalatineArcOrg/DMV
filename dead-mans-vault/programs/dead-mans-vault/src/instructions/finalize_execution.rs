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

    // Pay the keeper bounty (if any) to the cranker that finalized — the incentive
    // that makes permissionless cranking profitable. finalize runs exactly once
    // (guarded by the !executed constraint), so this pays at most once. The bounty
    // was carved out of the SOL snapshot at begin_execution, so the vault still
    // holds it above rent here; min() clamps if the vault was underfunded.
    let bounty = ctx.accounts.vault_config.keeper_bounty;
    if bounty > 0 {
        let vault_info = ctx.accounts.vault_config.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(vault_info.data_len());
        let available = vault_info.lamports().saturating_sub(rent_min);
        let amt = bounty.min(available);
        if amt > 0 {
            **vault_info.try_borrow_mut_lamports()? = vault_info
                .lamports()
                .checked_sub(amt)
                .ok_or(VaultError::InsufficientVaultBalance)?;
            let payer_info = ctx.accounts.payer.to_account_info();
            **payer_info.try_borrow_mut_lamports()? = payer_info
                .lamports()
                .checked_add(amt)
                .ok_or(VaultError::InsufficientVaultBalance)?;
        }
    }

    Ok(())
}
