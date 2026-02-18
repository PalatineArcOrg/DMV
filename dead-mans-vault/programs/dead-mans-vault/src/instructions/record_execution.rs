use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, ExecutionLog};
use crate::errors::VaultError;

#[derive(Accounts)]
pub struct RecordExecution<'info> {
    pub agent: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

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
        constraint = heartbeat_record.vault == vault_config.key() @ VaultError::HeartbeatVaultMismatch,
    )]
    pub heartbeat_record: Account<'info, HeartbeatRecord>,

    #[account(
        init,
        payer = payer,
        space = ExecutionLog::SPACE,
        seeds = [b"execution", vault_config.key().as_ref()],
        bump,
    )]
    pub execution_log: Account<'info, ExecutionLog>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RecordExecutionParams {
    pub transfer_count: u32,
    pub total_sol_distributed: u64,
    pub token_types_distributed: u32,
    pub attestation_hash: [u8; 32],
    pub completed: bool,
}

pub fn handler(ctx: Context<RecordExecution>, params: RecordExecutionParams) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault_config;
    let heartbeat = &ctx.accounts.heartbeat_record;

    // Enforce grace period — prevents a compromised agent from sealing
    // the vault before the owner's grace period has elapsed
    let deadline = heartbeat.last_heartbeat
        .checked_add(vault.heartbeat_interval)
        .and_then(|v| v.checked_add(vault.grace_period))
        .ok_or(VaultError::GracePeriodNotElapsed)?;
    require!(
        clock.unix_timestamp > deadline,
        VaultError::GracePeriodNotElapsed
    );

    // Create execution log
    let log = &mut ctx.accounts.execution_log;
    log.vault = ctx.accounts.vault_config.key();
    log.executed_at = clock.unix_timestamp;
    log.transfer_count = params.transfer_count;
    log.total_sol_distributed = params.total_sol_distributed;
    log.token_types_distributed = params.token_types_distributed;
    log.attestation_hash = params.attestation_hash;
    log.completed = params.completed;
    log.bump = ctx.bumps.execution_log;

    // Mark vault as executed — IRREVERSIBLE
    let vault = &mut ctx.accounts.vault_config;
    vault.executed = true;
    vault.active = false;

    Ok(())
}
