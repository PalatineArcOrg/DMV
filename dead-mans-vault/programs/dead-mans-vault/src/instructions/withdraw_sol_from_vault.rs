use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord};
use crate::errors::VaultError;
use crate::util::deadline;

#[derive(Accounts)]
pub struct WithdrawSolFromVault<'info> {
    /// Owner signs — only the vault owner can withdraw deposited SOL
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The vault PDA holds both config data AND deposited SOL.
    /// Lamports above rent-exemption are available for withdrawal.
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        seeds = [b"heartbeat", vault_config.key().as_ref()],
        bump = heartbeat_record.bump,
        constraint = heartbeat_record.vault == vault_config.key() @ VaultError::HeartbeatVaultMismatch,
    )]
    pub heartbeat_record: Account<'info, HeartbeatRecord>,
}

pub fn handler(ctx: Context<WithdrawSolFromVault>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InsufficientVaultBalance);

    // Freeze once grace has elapsed (R8/B1) — the snapshot belongs to the
    // beneficiaries; the owner can't drain it once execution is possible.
    {
        let now = Clock::get()?.unix_timestamp;
        let v = &ctx.accounts.vault_config;
        let dl = deadline(
            ctx.accounts.heartbeat_record.last_heartbeat,
            v.heartbeat_interval,
            v.grace_period,
        )?;
        require!(now < dl, VaultError::VaultFrozen);
    }

    let vault_info = ctx.accounts.vault_config.to_account_info();
    let owner_info = ctx.accounts.owner.to_account_info();

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
    **owner_info.try_borrow_mut_lamports()? = owner_info
        .lamports()
        .checked_add(amount)
        .ok_or(VaultError::InsufficientVaultBalance)?;

    Ok(())
}
