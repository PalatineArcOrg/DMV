use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord};
use crate::errors::VaultError;
use crate::util::deadline;

#[derive(Accounts)]
pub struct RotateAgent<'info> {
    /// Only the owner can rotate the agent key.
    /// The OLD agent must NOT be able to rotate itself.
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ VaultError::UnauthorizedOwner,
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

pub fn handler(ctx: Context<RotateAgent>, new_agent_pubkey: Pubkey) -> Result<()> {
    // Freeze once grace has elapsed (R8/B1) — a post-deadline rotation would
    // reset the heartbeat and cancel an execution that is already permissionless.
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

    let vault = &mut ctx.accounts.vault_config;
    let heartbeat = &mut ctx.accounts.heartbeat_record;

    // Guard 1: Prevent rotating to the zero address
    require!(
        new_agent_pubkey != Pubkey::default(),
        VaultError::InvalidAgentPubkey
    );

    // Guard 2: Prevent rotating to the owner's own key
    require!(
        new_agent_pubkey != vault.owner,
        VaultError::AgentCannotBeOwner
    );

    // Guard 3: Prevent no-op rotation (same key)
    require!(
        new_agent_pubkey != vault.agent_pubkey,
        VaultError::AgentKeyUnchanged
    );

    let clock = Clock::get()?;

    // Rotate the agent key
    vault.agent_pubkey = new_agent_pubkey;
    vault.updated_at = clock.unix_timestamp;

    // Reset heartbeat to force new agent to prove liveness
    heartbeat.last_heartbeat = clock.unix_timestamp;

    Ok(())
}
