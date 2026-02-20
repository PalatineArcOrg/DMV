use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord};
use crate::errors::VaultError;

/// Closes a previously-revoked vault and its heartbeat record,
/// returning rent to the owner. This handles zombie vaults from
/// before the program upgrade that added account closing to revoke.
#[derive(Accounts)]
pub struct CloseRevokedVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
        constraint = !vault_config.active @ VaultError::VaultStillActive,
        constraint = !vault_config.executed @ VaultError::VaultAlreadyExecuted,
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
}

pub fn handler(_ctx: Context<CloseRevokedVault>) -> Result<()> {
    Ok(())
}
