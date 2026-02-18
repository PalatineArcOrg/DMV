use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord};
use crate::errors::VaultError;

#[derive(Accounts)]
pub struct ExecuteSolDistribution<'info> {
    /// Agent signs — must match vault_config.agent_pubkey
    pub agent: Signer<'info>,

    /// The vault PDA holds both config data AND deposited SOL.
    /// Lamports above rent-exemption are available for distribution.
    #[account(
        mut,
        seeds = [b"vault", vault_config.owner.as_ref()],
        bump = vault_config.bump,
        constraint = vault_config.active @ VaultError::VaultInactive,
        constraint = !vault_config.executed @ VaultError::VaultAlreadyExecuted,
        constraint = vault_config.agent_pubkey == agent.key() @ VaultError::UnauthorizedAgent,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        seeds = [b"heartbeat", vault_config.key().as_ref()],
        bump = heartbeat_record.bump,
    )]
    pub heartbeat_record: Account<'info, HeartbeatRecord>,

    /// Beneficiary wallet to receive SOL — must be in vault whitelist.
    /// CHECK: Validated against vault_config.beneficiaries in handler.
    #[account(mut)]
    pub beneficiary: AccountInfo<'info>,
}

pub fn handler(
    ctx: Context<ExecuteSolDistribution>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, VaultError::InsufficientVaultBalance);

    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault_config;
    let heartbeat = &ctx.accounts.heartbeat_record;

    // Verify grace period has fully elapsed
    let deadline = heartbeat.last_heartbeat
        .checked_add(vault.heartbeat_interval)
        .and_then(|v| v.checked_add(vault.grace_period))
        .ok_or(VaultError::GracePeriodNotElapsed)?;
    require!(
        clock.unix_timestamp > deadline,
        VaultError::GracePeriodNotElapsed
    );

    // Verify destination is a registered beneficiary
    let beneficiary_key = ctx.accounts.beneficiary.key();
    let is_registered = vault.beneficiaries.iter().any(|b| b.wallet == beneficiary_key);
    require!(is_registered, VaultError::UnregisteredBeneficiary);

    // Transfer SOL via direct lamport manipulation.
    // The vault PDA is owned by this program, so system_program::transfer
    // cannot be used. Instead, we directly debit/credit lamports.
    let vault_info = ctx.accounts.vault_config.to_account_info();
    let beneficiary_info = ctx.accounts.beneficiary.to_account_info();

    // Ensure vault retains enough lamports for rent exemption
    let rent = Rent::get()?;
    let min_balance = rent.minimum_balance(vault_info.data_len());
    let available = vault_info.lamports()
        .checked_sub(min_balance)
        .ok_or(VaultError::InsufficientVaultBalance)?;
    require!(amount <= available, VaultError::InsufficientVaultBalance);

    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(amount)
        .ok_or(VaultError::InsufficientVaultBalance)?;
    **beneficiary_info.try_borrow_mut_lamports()? = beneficiary_info
        .lamports()
        .checked_add(amount)
        .ok_or(VaultError::InsufficientVaultBalance)?;

    Ok(())
}
