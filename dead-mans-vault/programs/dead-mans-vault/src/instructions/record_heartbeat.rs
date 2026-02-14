use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, HeartbeatMethod};
use crate::errors::VaultError;

#[derive(Accounts)]
pub struct RecordHeartbeat<'info> {
    /// The agent's TEE-generated keypair signs this
    pub agent: Signer<'info>,

    #[account(
        constraint = vault_config.agent_pubkey == agent.key() @ VaultError::UnauthorizedAgent,
        constraint = vault_config.active @ VaultError::VaultInactive,
        constraint = !vault_config.executed @ VaultError::VaultAlreadyExecuted,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        mut,
        seeds = [b"heartbeat", vault_config.key().as_ref()],
        bump = heartbeat_record.bump,
        constraint = heartbeat_record.vault == vault_config.key() @ VaultError::HeartbeatVaultMismatch,
    )]
    pub heartbeat_record: Account<'info, HeartbeatRecord>,
}

pub fn handler(ctx: Context<RecordHeartbeat>, method: HeartbeatMethod) -> Result<()> {
    let clock = Clock::get()?;
    let heartbeat = &mut ctx.accounts.heartbeat_record;

    heartbeat.last_heartbeat = clock.unix_timestamp;
    heartbeat.last_method = method;
    heartbeat.total_heartbeats += 1;

    msg!("Heartbeat recorded at: {}", heartbeat.last_heartbeat);
    msg!("Total heartbeats: {}", heartbeat.total_heartbeats);

    Ok(())
}
