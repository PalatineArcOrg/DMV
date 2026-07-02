use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, Beneficiary, HeartbeatMethod};
use crate::errors::VaultError;
use crate::constants::*;

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = VaultConfig::SPACE,
        seeds = [b"vault", owner.key().as_ref()],
        bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        init,
        payer = owner,
        space = HeartbeatRecord::SPACE,
        seeds = [b"heartbeat", vault_config.key().as_ref()],
        bump,
    )]
    pub heartbeat_record: Account<'info, HeartbeatRecord>,

    /// Recipient of the on-chain vault-creation fee. Pinned to the hardcoded
    /// FEE_WALLET, so a vault cannot be created without paying the fee.
    #[account(mut, address = FEE_WALLET @ VaultError::InvalidFeeRecipient)]
    pub fee_recipient: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeVaultParams {
    pub agent_pubkey: Pubkey,
    pub heartbeat_interval: i64,
    pub grace_period: i64,
    pub beneficiaries: Vec<Beneficiary>,
    pub is_mutable: bool,
}

pub fn handler(ctx: Context<InitializeVault>, params: InitializeVaultParams) -> Result<()> {
    // Validate heartbeat interval (minimum 1 day)
    require!(
        params.heartbeat_interval >= MIN_HEARTBEAT_INTERVAL,
        VaultError::HeartbeatIntervalTooShort
    );

    // Validate grace period (minimum 7 days)
    require!(
        params.grace_period >= MIN_GRACE_PERIOD,
        VaultError::GracePeriodTooShort
    );

    // Validate beneficiary count
    require!(
        !params.beneficiaries.is_empty() && params.beneficiaries.len() <= MAX_BENEFICIARIES,
        VaultError::InvalidBeneficiaryCount
    );

    // Validate share sum = 10000 bps (100%)
    let total_bps: u32 = params.beneficiaries.iter().map(|b| b.share_bps as u32).sum();
    require!(total_bps == 10000, VaultError::InvalidShareAllocation);

    // Validate no beneficiary is the owner
    for b in &params.beneficiaries {
        require!(b.wallet != ctx.accounts.owner.key(), VaultError::OwnerCannotBeBeneficiary);
    }

    // Validate agent pubkey is not zero address
    require!(
        params.agent_pubkey != Pubkey::default(),
        VaultError::InvalidAgentPubkey
    );

    // Validate agent is not the owner
    require!(
        params.agent_pubkey != ctx.accounts.owner.key(),
        VaultError::AgentCannotBeOwner
    );

    let clock = Clock::get()?;

    // Initialize vault config
    let vault = &mut ctx.accounts.vault_config;
    vault.owner = ctx.accounts.owner.key();
    vault.agent_pubkey = params.agent_pubkey;
    vault.heartbeat_interval = params.heartbeat_interval;
    vault.grace_period = params.grace_period;
    vault.beneficiaries = params.beneficiaries;
    vault.executed = false;
    vault.active = true;
    vault.created_at = clock.unix_timestamp;
    vault.updated_at = clock.unix_timestamp;
    vault.bump = ctx.bumps.vault_config;
    vault.is_mutable = params.is_mutable;
    vault.has_asset_plan = false;
    vault.open_token_dists = 0;

    // Initialize heartbeat record with current time
    let heartbeat = &mut ctx.accounts.heartbeat_record;
    heartbeat.vault = vault.key();
    heartbeat.last_heartbeat = clock.unix_timestamp;
    heartbeat.last_method = HeartbeatMethod::ActiveTap;
    heartbeat.total_heartbeats = 1;
    heartbeat.bump = ctx.bumps.heartbeat_record;

    // Collect the vault-creation fee (owner -> fee wallet), enforced on-chain.
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.fee_recipient.to_account_info(),
            },
        ),
        VAULT_CREATION_FEE_LAMPORTS,
    )?;

    Ok(())
}
