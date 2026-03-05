use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, ExecutionLog};
use crate::errors::VaultError;

/// Closes all PDAs of an executed vault, returning rent to the owner.
/// Called by the agent after record_execution completes.
#[derive(Accounts)]
pub struct CloseExecutedVault<'info> {
    /// Agent signer — must match vault's registered agent
    pub agent: Signer<'info>,

    /// Owner wallet — receives rent refund (does not need to sign)
    /// CHECK: Validated via vault_config.owner has_one constraint
    #[account(mut)]
    pub owner: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
        constraint = vault_config.executed @ VaultError::VaultNotExecuted,
        constraint = vault_config.agent_pubkey == agent.key() @ VaultError::UnauthorizedAgent,
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

pub fn handler(_ctx: Context<CloseExecutedVault>) -> Result<()> {
    // Anchor's `close` attribute handles zeroing account data,
    // transferring lamports to owner, and freeing the PDA slots.
    Ok(())
}
