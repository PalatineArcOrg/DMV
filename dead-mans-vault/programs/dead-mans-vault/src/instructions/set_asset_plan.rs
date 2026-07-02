use anchor_lang::prelude::*;
use crate::state::{VaultConfig, HeartbeatRecord, AssetPlan, AssetAssignment};
use crate::errors::VaultError;
use crate::constants::MAX_ASSIGNMENTS;
use crate::util::deadline;

/// Validate an assignment list. Per B4, NFT *shape* (decimals 0 / supply 1) is
/// validated client-side (a mis-flagged NFT only harms the owner's own vault).
/// On-chain we keep the cheap, mint-account-free checks:
///   - count within cap
///   - every beneficiary_index in range
///   - at most one assignment per NFT mint
pub fn validate_assignments(
    assignments: &[AssetAssignment],
    beneficiary_count: usize,
) -> Result<()> {
    require!(
        assignments.len() <= MAX_ASSIGNMENTS,
        VaultError::TooManyAssignments
    );

    for a in assignments {
        require!(
            (a.beneficiary_index as usize) < beneficiary_count,
            VaultError::InvalidBeneficiaryIndex
        );

        // A SOL bequest is signalled by the zero-pubkey sentinel mint. It is a
        // lamport transfer (never an NFT) and a zero amount is meaningless.
        if a.mint == Pubkey::default() {
            require!(!a.is_nft && a.amount > 0, VaultError::InvalidSolBequest);
        }
    }

    for (i, a) in assignments.iter().enumerate() {
        if a.is_nft {
            for prev in &assignments[..i] {
                require!(
                    !(prev.is_nft && prev.mint == a.mint),
                    VaultError::DuplicateNftAssignment
                );
            }
        }
    }

    Ok(())
}

#[derive(Accounts)]
pub struct SetAssetPlan<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
        constraint = vault_config.active @ VaultError::VaultInactive,
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
        payer = owner,
        space = AssetPlan::SPACE,
        seeds = [b"asset_plan", vault_config.key().as_ref()],
        bump,
    )]
    pub asset_plan: Account<'info, AssetPlan>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SetAssetPlan>, assignments: Vec<AssetAssignment>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault = &ctx.accounts.vault_config;
    let hb = &ctx.accounts.heartbeat_record;

    // Pre-grace only — once execution is possible the plan must not change.
    let dl = deadline(hb.last_heartbeat, vault.heartbeat_interval, vault.grace_period)?;
    require!(now < dl, VaultError::AssetPlanImmutable);

    validate_assignments(&assignments, vault.beneficiaries.len())?;

    let plan = &mut ctx.accounts.asset_plan;
    plan.vault = vault.key();
    plan.assignments = assignments;
    plan.paid_mask = 0;
    plan.bump = ctx.bumps.asset_plan;

    ctx.accounts.vault_config.has_asset_plan = true;

    Ok(())
}
