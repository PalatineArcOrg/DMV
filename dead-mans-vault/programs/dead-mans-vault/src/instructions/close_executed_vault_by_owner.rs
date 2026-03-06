use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, ExecutionLog};
use crate::errors::VaultError;

/// Owner-signed cleanup of an executed vault. Closes all three PDAs
/// (VaultConfig, HeartbeatRecord, ExecutionLog), returning rent to owner.
/// Used when re-initializing a vault on the same wallet after execution.
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
}

pub fn handler(_ctx: Context<CloseExecutedVaultByOwner>) -> Result<()> {
    Ok(())
}
