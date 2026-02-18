use anchor_lang::prelude::*;
use crate::state::{VaultConfig, Beneficiary};
use crate::errors::VaultError;
use crate::constants::*;

#[derive(Accounts)]
pub struct UpdateVault<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ VaultError::UnauthorizedOwner,
        constraint = vault_config.active @ VaultError::VaultInactive,
        constraint = !vault_config.executed @ VaultError::VaultAlreadyExecuted,
        constraint = vault_config.is_mutable @ VaultError::VaultImmutable,
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct UpdateVaultParams {
    pub heartbeat_interval: Option<i64>,
    pub grace_period: Option<i64>,
    pub beneficiaries: Option<Vec<Beneficiary>>,
}

pub fn handler(ctx: Context<UpdateVault>, params: UpdateVaultParams) -> Result<()> {
    let vault = &mut ctx.accounts.vault_config;
    let clock = Clock::get()?;

    if let Some(interval) = params.heartbeat_interval {
        require!(
            interval >= MIN_HEARTBEAT_INTERVAL,
            VaultError::HeartbeatIntervalTooShort
        );
        vault.heartbeat_interval = interval;
    }

    if let Some(grace) = params.grace_period {
        require!(
            grace >= MIN_GRACE_PERIOD,
            VaultError::GracePeriodTooShort
        );
        vault.grace_period = grace;
    }

    if let Some(beneficiaries) = params.beneficiaries {
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
