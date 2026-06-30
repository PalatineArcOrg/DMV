use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, ExecutionLog, AssetPlan};
use crate::errors::VaultError;
use crate::util::largest_share_index;

/// Owner-signed final cleanup of an executed vault (B2 — the core-PDA close is
/// NOT permissionless in v1, to avoid orphaning tokens of a never-distributed
/// mint). Closes VaultConfig, HeartbeatRecord, ExecutionLog, and the AssetPlan
/// (if any), returning their rent to the owner. Any residual SOL dust above the
/// VaultConfig rent is swept to the largest-share beneficiary first (D5).
///
/// Inheritance correctness does NOT depend on this close — beneficiaries have
/// already received every asset via the permissionless flow. The caller must
/// have run `close_token_dist` for every held mint before this (R9).
#[derive(Accounts)]
pub struct CloseExecutedVaultByOwner<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
        constraint = vault_config.executed @ VaultError::VaultNotExecuted,
        close = owner,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        mut,
        seeds = [b"heartbeat", vault_config.key().as_ref()],
        bump = heartbeat_record.bump,
        constraint = heartbeat_record.vault == vault_config.key() @ VaultError::HeartbeatVaultMismatch,
        close = owner,
    )]
    pub heartbeat_record: Account<'info, HeartbeatRecord>,

    #[account(
        mut,
        seeds = [b"execution", vault_config.key().as_ref()],
        bump = execution_log.bump,
        constraint = execution_log.vault == vault_config.key(),
        close = owner,
    )]
    pub execution_log: Account<'info, ExecutionLog>,

    /// Present iff `vault_config.has_asset_plan`. Closed manually (rent → owner)
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

pub fn handler(ctx: Context<CloseExecutedVaultByOwner>) -> Result<()> {
    let vault = &ctx.accounts.vault_config;

    // R9: every started token distribution must be closed first, or its residual
    // would be orphaned (the vault PDA can never sign again once VaultConfig is
    // closed). The crank runs close_token_dist for every held mint before this.
    require!(vault.open_token_dists == 0, VaultError::TokensRemain);

    // Sweep SOL dust (anything above the VaultConfig rent) to the largest-share
    // beneficiary, so Anchor's `close = owner` then returns only rent to owner.
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
        let owner_info = ctx.accounts.owner.to_account_info();
        let plan_lamports = plan_info.lamports();
        **owner_info.try_borrow_mut_lamports()? = owner_info
            .lamports()
            .checked_add(plan_lamports)
            .ok_or(VaultError::InsufficientVaultBalance)?;
        **plan_info.try_borrow_mut_lamports()? = 0;
        plan_info.assign(&anchor_lang::system_program::ID);
        plan_info.resize(0)?;
    }

    Ok(())
}
