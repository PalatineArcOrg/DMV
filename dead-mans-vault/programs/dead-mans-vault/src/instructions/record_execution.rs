use anchor_lang::prelude::*;
use crate::state::{VaultConfig, ExecutionLog};
use crate::errors::VaultError;

#[derive(Accounts)]
pub struct RecordExecution<'info> {
    pub agent: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        constraint = vault_config.agent_pubkey == agent.key() @ VaultError::UnauthorizedAgent,
        constraint = !vault_config.executed @ VaultError::VaultAlreadyExecuted,
    )]
    pub vault_config: Account<'info, VaultConfig>,

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

    msg!("Execution recorded. Vault permanently sealed.");

    Ok(())
}
