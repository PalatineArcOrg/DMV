use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, ExecutionLog};
use crate::errors::VaultError;
use crate::util::{deadline, grace_elapsed};

/// Permissionless. Strict `init` — the first caller after grace snapshots the
/// SOL residual; the account's existence then proves grace for every downstream
/// permissionless instruction (B1), so they need not re-load the heartbeat.
#[derive(Accounts)]
pub struct BeginExecution<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"vault", vault_config.owner.as_ref()],
        bump = vault_config.bump,
        constraint = !vault_config.executed @ VaultError::VaultAlreadyExecuted,
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

pub fn handler(ctx: Context<BeginExecution>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault = &ctx.accounts.vault_config;
    let hb = &ctx.accounts.heartbeat_record;

    let dl = deadline(hb.last_heartbeat, vault.heartbeat_interval, vault.grace_period)?;
    require!(grace_elapsed(now, dl), VaultError::GraceNotElapsed);

    // Snapshot SOL residual = vault lamports above rent-exemption. SOL is pure
    // pro-rata in v1 (no specific-SOL bequests), so no AssetPlan read here.
    let vault_info = vault.to_account_info();
    let rent_min = Rent::get()?.minimum_balance(vault_info.data_len());
    let sol_snapshot = vault_info.lamports().saturating_sub(rent_min);

    let log = &mut ctx.accounts.execution_log;
    log.vault = vault.key();
    log.sol_snapshot = sol_snapshot;
    log.sol_paid_mask = 0;
    log.started_at = now;
    log.completed = false;
    log.transfer_count = 0;
    log.total_sol_distributed = 0;
    log.bump = ctx.bumps.execution_log;

    Ok(())
}
