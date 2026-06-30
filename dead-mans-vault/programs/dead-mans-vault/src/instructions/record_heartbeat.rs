use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, HeartbeatMethod};
use crate::errors::VaultError;
use crate::util::deadline;

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

    // Freeze (B1): once grace has fully elapsed the deadline is reached and
    // execution can begin permissionlessly — a heartbeat must not reset the
    // clock and cancel it. Time only moves forward, so once an ExecutionLog
    // could exist, every heartbeat is past the deadline and blocked here.
    let vault = &ctx.accounts.vault_config;
    let dl = deadline(
        ctx.accounts.heartbeat_record.last_heartbeat,
        vault.heartbeat_interval,
        vault.grace_period,
    )?;
    require!(clock.unix_timestamp < dl, VaultError::VaultFrozen);

    let heartbeat = &mut ctx.accounts.heartbeat_record;
    heartbeat.last_heartbeat = clock.unix_timestamp;
    heartbeat.last_method = method;
    heartbeat.total_heartbeats = heartbeat.total_heartbeats
        .checked_add(1)
        .ok_or(error!(VaultError::HeartbeatIntervalTooShort))?;

    Ok(())
}
