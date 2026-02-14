use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{VaultConfig, HeartbeatRecord};
use crate::errors::VaultError;

#[derive(Accounts)]
pub struct ExecuteDistribution<'info> {
    /// Agent signs — must match vault_config.agent_pubkey
    pub agent: Signer<'info>,

    #[account(
        mut,
        constraint = vault_config.active @ VaultError::VaultInactive,
        constraint = !vault_config.executed @ VaultError::VaultAlreadyExecuted,
        constraint = vault_config.agent_pubkey == agent.key() @ VaultError::UnauthorizedAgent,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        seeds = [b"heartbeat", vault_config.key().as_ref()],
        bump = heartbeat_record.bump,
    )]
    pub heartbeat_record: Account<'info, HeartbeatRecord>,

    /// Owner's token account to transfer FROM
    #[account(mut)]
    pub source_token_account: Account<'info, TokenAccount>,

    /// Beneficiary's token account to transfer TO
    #[account(mut)]
    pub destination_token_account: Account<'info, TokenAccount>,

    /// Vault PDA as delegate authority
    /// CHECK: PDA verification done via seeds
    #[account(
        seeds = [b"vault", vault_config.owner.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<ExecuteDistribution>,
    amount: u64,
    _attestation_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.vault_config;
    let heartbeat = &ctx.accounts.heartbeat_record;

    // CRITICAL: Verify grace period has fully elapsed
    let deadline = heartbeat.last_heartbeat
        .checked_add(vault.heartbeat_interval)
        .and_then(|v| v.checked_add(vault.grace_period))
        .ok_or(VaultError::GracePeriodNotElapsed)?;
    require!(
        clock.unix_timestamp > deadline,
        VaultError::GracePeriodNotElapsed
    );

    // Verify destination is a registered beneficiary
    let dest_owner = ctx.accounts.destination_token_account.owner;
    let is_registered = vault.beneficiaries.iter().any(|b| b.wallet == dest_owner);
    require!(is_registered, VaultError::UnregisteredBeneficiary);

    // Execute transfer using vault PDA as delegate
    let owner_key = vault.owner;
    let seeds = &[
        b"vault".as_ref(),
        owner_key.as_ref(),
        &[vault.bump],
    ];
    let signer_seeds = &[&seeds[..]];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.source_token_account.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer_seeds,
    );

    token::transfer(transfer_ctx, amount)?;

    msg!("Distributed {} tokens to beneficiary", amount);

    Ok(())
}
