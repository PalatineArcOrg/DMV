use anchor_lang::prelude::*;
use crate::constants::EXECUTED_CLOSE_DELAY;
use crate::errors::VaultError;
use crate::state::{AssetPlan, ExecutionLog, HeartbeatRecord, VaultConfig};
use crate::util::largest_share_index;

/// PERMISSIONLESS final cleanup of an executed vault — the keeper-facing twin of
/// `close_executed_vault_by_owner`. Once execution has finalized, all TokenDists
/// are closed, and the owner-exclusive window (`EXECUTED_CLOSE_DELAY`) has
/// elapsed, ANY payer may close VaultConfig, HeartbeatRecord, ExecutionLog, and
/// the AssetPlan (if any), claiming their rents as the cleanup reward. Without
/// this, a dead owner's rent (~0.01–0.03 SOL) strands forever — the owner-signed
/// close can never run again.
///
/// Fund-safety is unchanged: SOL dust above the VaultConfig rent is swept to the
/// largest-share beneficiary first (D5), exactly as in the owner close; the payer
/// receives only the rents. Inheritance correctness does not depend on this close
/// — beneficiaries already received every asset. A living owner keeps priority:
/// they can close (and reclaim their own rent) any time via the owner-signed ix;
/// this one unlocks only after the window.
#[derive(Accounts)]
pub struct CloseExecutedVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault_config.owner.as_ref()],
        bump = vault_config.bump,
        constraint = vault_config.executed @ VaultError::VaultNotExecuted,
        close = payer,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        mut,
        seeds = [b"heartbeat", vault_config.key().as_ref()],
        bump = heartbeat_record.bump,
        constraint = heartbeat_record.vault == vault_config.key() @ VaultError::HeartbeatVaultMismatch,
        close = payer,
    )]
    pub heartbeat_record: Account<'info, HeartbeatRecord>,

    #[account(
        mut,
        seeds = [b"execution", vault_config.key().as_ref()],
        bump = execution_log.bump,
        constraint = execution_log.vault == vault_config.key(),
        constraint = execution_log.completed @ VaultError::NotAllSharesPaid,
        close = payer,
    )]
    pub execution_log: Account<'info, ExecutionLog>,

    /// Present iff `vault_config.has_asset_plan`. Closed manually (rent → payer)
    /// so the PDA slot frees for a future re-init on the same wallet.
    #[account(
        mut,
        seeds = [b"asset_plan", vault_config.key().as_ref()],
        bump,
    )]
    pub asset_plan: Option<Account<'info, AssetPlan>>,

    /// Required only when SOL dust remains to be swept.
    /// CHECK: pinned to the largest-share beneficiary wallet when dust > 0.
    #[account(mut)]
    pub largest_benef: Option<UncheckedAccount<'info>>,
}

pub fn handler(ctx: Context<CloseExecutedVault>) -> Result<()> {
    let vault = &ctx.accounts.vault_config;

    // R9: every started token distribution must be closed first, or its residual
    // would be orphaned (the vault PDA can never sign again once VaultConfig is
    // closed). The crank runs close_token_dist for every held mint before this.
    require!(vault.open_token_dists == 0, VaultError::TokensRemain);

    // Owner-exclusive window: give a living owner first claim on their own rent.
    // Anchored on `started_at` (execution start) — finalize follows within
    // minutes, and it avoids a layout change for a completion timestamp.
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.execution_log.started_at + EXECUTED_CLOSE_DELAY,
        VaultError::CloseDelayNotElapsed
    );

    // Sweep SOL dust (anything above the VaultConfig rent) to the largest-share
    // beneficiary, so Anchor's `close = payer` then returns only rent to payer.
    let vault_info = vault.to_account_info();
    let rent_min = Rent::get()?.minimum_balance(vault_info.data_len());
    let dust = vault_info.lamports().saturating_sub(rent_min);
    if dust > 0 {
        let max_idx = largest_share_index(&vault.beneficiaries);
        let max_wallet = vault.beneficiaries[max_idx].wallet;
        let benef = ctx
            .accounts
            .largest_benef
            .as_ref()
            .ok_or(error!(VaultError::BeneficiaryMismatch))?;
        require!(benef.key() == max_wallet, VaultError::BeneficiaryMismatch);

        let benef_info = benef.to_account_info();
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(dust)
            .ok_or(VaultError::InsufficientVaultBalance)?;
        **benef_info.try_borrow_mut_lamports()? = benef_info
            .lamports()
            .checked_add(dust)
            .ok_or(VaultError::InsufficientVaultBalance)?;
    }

    // Manually close the AssetPlan (Anchor `close` on an Optional account is
    // avoided for portability). Required when the vault registered a plan.
    if vault.has_asset_plan {
        let plan = ctx
            .accounts
            .asset_plan
            .as_ref()
            .ok_or(error!(VaultError::AssetPlanRequired))?;
        require!(plan.vault == vault.key(), VaultError::AssetPlanRequired);

        let plan_info = plan.to_account_info();
        let payer_info = ctx.accounts.payer.to_account_info();
        let plan_lamports = plan_info.lamports();
        **payer_info.try_borrow_mut_lamports()? = payer_info
            .lamports()
            .checked_add(plan_lamports)
            .ok_or(VaultError::InsufficientVaultBalance)?;
        **plan_info.try_borrow_mut_lamports()? = 0;
        plan_info.assign(&anchor_lang::system_program::ID);
        plan_info.resize(0)?;
    }

    Ok(())
}
