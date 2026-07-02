use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, ExecutionLog, AssetPlan};
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

    /// Required iff `vault_config.has_asset_plan` — read to carve specific-SOL
    /// bequests out of the pro-rata residual (pinned by seeds; omitted otherwise).
    #[account(
        seeds = [b"asset_plan", vault_config.key().as_ref()],
        bump,
    )]
    pub asset_plan: Option<Account<'info, AssetPlan>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<BeginExecution>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault = &ctx.accounts.vault_config;
    let hb = &ctx.accounts.heartbeat_record;

    let dl = deadline(hb.last_heartbeat, vault.heartbeat_interval, vault.grace_period)?;
    require!(grace_elapsed(now, dl), VaultError::GraceNotElapsed);

    // Sum specific-SOL bequests (zero-pubkey sentinel mint) so they are carved out
    // of the pro-rata residual, mirroring how begin_token_dist carves specifics out
    // of a token's residual. When the vault has a plan the account is REQUIRED and
    // pinned (a missing/wrong plan here would let pro-rata over-distribute).
    let mut specific_sol: u128 = 0;
    if vault.has_asset_plan {
        let plan = ctx
            .accounts
            .asset_plan
            .as_ref()
            .ok_or(error!(VaultError::AssetPlanRequired))?;
        require!(plan.vault == vault.key(), VaultError::AssetPlanRequired);
        for a in plan.assignments.iter() {
            if a.mint == Pubkey::default() {
                specific_sol = specific_sol.saturating_add(a.amount as u128);
            }
        }
    }

    // Snapshot SOL residual = (vault lamports above rent-exemption) − Σ specific-SOL.
    // The residual is split pro-rata by execute_sol_shares; the specific amounts are
    // paid separately by execute_specific_sol.
    let vault_info = vault.to_account_info();
    let rent_min = Rent::get()?.minimum_balance(vault_info.data_len());
    // Also carve out the keeper bounty (paid to the finalize cranker) so it never
    // reduces beneficiary payouts.
    let distributable = vault_info.lamports().saturating_sub(rent_min) as u128;
    let sol_snapshot = distributable
        .saturating_sub(specific_sol)
        .saturating_sub(vault.keeper_bounty as u128) as u64;

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
