use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, AssetPlan};
use crate::errors::VaultError;
use crate::util::deadline;

/// Owner-only, PRE-GRACE. Closes the vault's AssetPlan (rent → owner) and clears
/// `has_asset_plan`, so the owner can edit their beneficiary set — which `update_vault`
/// locks while a plan exists (`BeneficiariesLockedByPlan`) — and then re-`set_asset_plan`.
///
/// The `now < deadline` freeze is the CORRECTNESS BOUNDARY (not optional): every plan
/// mutation is gated pre-grace and every execution reader is gated post-grace
/// (`begin_execution`/`begin_token_dist` carve the specific bequests out of the frozen
/// snapshots). Those two sets are temporally disjoint, so a clear can never desync a
/// snapshot that execution already took — un-gated, a clear after `begin_execution` would
/// reroute the carved-out specifics to the largest-share heir. Closing the PDA AND
/// clearing the flag happen atomically here: doing either alone bricks the vault (a stale
/// flag blocks execution; a lingering PDA blocks a later `set_asset_plan` re-`init`).
/// NOT gated on `is_mutable` (mirrors set/update_asset_plan) — clearing back to pro-rata
/// is a legitimate standalone action; the follow-on beneficiary edit still needs a mutable
/// vault, which `update_vault` enforces separately.
#[derive(Accounts)]
pub struct ClearAssetPlan<'info> {
    /// Owner signs and receives the AssetPlan rent refund.
    #[account(mut)]
    pub owner: Signer<'info>,

    // A no-plan vault is already rejected by the required `asset_plan` account failing to
    // load (AccountNotInitialized). The has_asset_plan constraint here is defense-in-depth
    // against a has_asset_plan/AssetPlan-PDA desync (which set/clear keep atomic anyway).
    #[account(
        mut,
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

pub fn handler(ctx: Context<ClearAssetPlan>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // Pre-grace freeze — identical to set/update_asset_plan / update_vault / revoke.
    {
        let vault = &ctx.accounts.vault_config;
        let dl = deadline(
            ctx.accounts.heartbeat_record.last_heartbeat,
            vault.heartbeat_interval,
            vault.grace_period,
        )?;
        require!(now < dl, VaultError::VaultFrozen);
    }

    // Close the AssetPlan PDA (rent → owner), mirroring revoke_vault's manual close so
    // the ["asset_plan", vault] slot frees for a later re-`set_asset_plan`. assign() to
    // System *before* resize(0) so Anchor's exit skips the (now foreign) account.
    let plan_info = ctx.accounts.asset_plan.to_account_info();
    let owner_info = ctx.accounts.owner.to_account_info();
    let plan_lamports = plan_info.lamports();
    **owner_info.try_borrow_mut_lamports()? = owner_info
        .lamports()
        .checked_add(plan_lamports)
        .ok_or(VaultError::InsufficientVaultBalance)?;
    **plan_info.try_borrow_mut_lamports()? = 0;
    plan_info.assign(&anchor_lang::system_program::ID);
    plan_info.resize(0)?;

    // Atomically clear the flag so update_vault unlocks beneficiary edits and
    // begin_execution takes the no-plan branch. Both writes commit or revert together.
    ctx.accounts.vault_config.has_asset_plan = false;

    Ok(())
}
