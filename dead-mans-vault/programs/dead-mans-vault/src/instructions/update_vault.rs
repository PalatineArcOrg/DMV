use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, Beneficiary};
use crate::errors::VaultError;
use crate::constants::*;
use crate::util::deadline;

#[derive(Accounts)]
pub struct UpdateVault<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
        constraint = vault_config.active @ VaultError::VaultInactive,
        constraint = !vault_config.executed @ VaultError::VaultAlreadyExecuted,
        constraint = vault_config.is_mutable @ VaultError::VaultImmutable,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        seeds = [b"heartbeat", vault_config.key().as_ref()],
        bump = heartbeat_record.bump,
        constraint = heartbeat_record.vault == vault_config.key() @ VaultError::HeartbeatVaultMismatch,
    )]
    pub heartbeat_record: Account<'info, HeartbeatRecord>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct UpdateVaultParams {
    pub heartbeat_interval: Option<i64>,
    pub grace_period: Option<i64>,
    pub beneficiaries: Option<Vec<Beneficiary>>,
}

pub fn handler(ctx: Context<UpdateVault>, params: UpdateVaultParams) -> Result<()> {
    let clock = Clock::get()?;

    // Freeze once grace has elapsed (R8/B1) — no owner mutation while execution
    // is possible. Uses the current heartbeat (mutation can't reset the clock).
    {
        let vault = &ctx.accounts.vault_config;
        let dl = deadline(
            ctx.accounts.heartbeat_record.last_heartbeat,
            vault.heartbeat_interval,
            vault.grace_period,
        )?;
        require!(clock.unix_timestamp < dl, VaultError::VaultFrozen);
    }

    let vault = &mut ctx.accounts.vault_config;

    if let Some(interval) = params.heartbeat_interval {
        require!(
            interval >= MIN_HEARTBEAT_INTERVAL,
            VaultError::HeartbeatIntervalTooShort
        );
        require!(
            interval <= MAX_HEARTBEAT_INTERVAL,
            VaultError::HeartbeatIntervalTooLong
        );
        vault.heartbeat_interval = interval;
    }

    if let Some(grace) = params.grace_period {
        require!(
            grace >= MIN_GRACE_PERIOD,
            VaultError::GracePeriodTooShort
        );
        require!(
            grace <= MAX_GRACE_PERIOD,
            VaultError::GracePeriodTooLong
        );
        vault.grace_period = grace;
    }

    if let Some(beneficiaries) = params.beneficiaries {
        // Beneficiary indices are referenced by the AssetPlan; changing the set
        // would silently re-point assignments. The owner must run `clear_asset_plan`
        // first (pre-grace), then edit beneficiaries, then re-`set_asset_plan` (P10/M-2).
        require!(!vault.has_asset_plan, VaultError::BeneficiariesLockedByPlan);

        require!(
            !beneficiaries.is_empty() && beneficiaries.len() <= MAX_BENEFICIARIES,
            VaultError::InvalidBeneficiaryCount
        );

        let total_bps: u32 = beneficiaries.iter().map(|b| b.share_bps as u32).sum();
        require!(total_bps == 10000, VaultError::InvalidShareAllocation);

        for b in &beneficiaries {
            require!(b.wallet != vault.owner, VaultError::OwnerCannotBeBeneficiary);
        }

        vault.beneficiaries = beneficiaries;
    }

    vault.updated_at = clock.unix_timestamp;

    Ok(())
}
