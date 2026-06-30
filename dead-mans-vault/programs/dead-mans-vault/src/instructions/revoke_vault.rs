use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, AssetPlan};
use crate::errors::VaultError;
use crate::util::deadline;

#[derive(Accounts)]
pub struct RevokeVault<'info> {
    /// Only the owner can revoke; receives rent refund from closed accounts
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
        constraint = vault_config.active @ VaultError::VaultInactive,
        constraint = !vault_config.executed @ VaultError::VaultAlreadyExecuted,
        constraint = vault_config.is_mutable @ VaultError::VaultImmutable,
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

    /// Present iff `vault_config.has_asset_plan`. Closed manually so its PDA slot
    /// frees for re-initialization on the same wallet.
    #[account(
        mut,
        seeds = [b"asset_plan", vault_config.key().as_ref()],
        bump,
    )]
    pub asset_plan: Option<Account<'info, AssetPlan>>,
}

pub fn handler(ctx: Context<RevokeVault>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // Freeze once grace has elapsed (R8/B1) — owner can't revoke while execution
    // is possible; that is the trustless dead-man's-switch guarantee.
    {
        let vault = &ctx.accounts.vault_config;
        let dl = deadline(
            ctx.accounts.heartbeat_record.last_heartbeat,
            vault.heartbeat_interval,
            vault.grace_period,
        )?;
        require!(now < dl, VaultError::VaultFrozen);
    }

    // Close the AssetPlan PDA (rent → owner) if one exists, so a later re-init
    // with a fresh plan is not blocked by the stale PDA.
    if ctx.accounts.vault_config.has_asset_plan {
        let plan = ctx
            .accounts
            .asset_plan
            .as_ref()
            .ok_or(error!(VaultError::AssetPlanRequired))?;
        require!(
            plan.vault == ctx.accounts.vault_config.key(),
            VaultError::AssetPlanRequired
        );

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

    // Anchor's `close` attribute handles VaultConfig + HeartbeatRecord.
    Ok(())
}
