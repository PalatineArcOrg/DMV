use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{extension::StateWithExtensions, state::Mint};
use crate::state::{VaultConfig, HeartbeatRecord, AssetPlan, AssetAssignment};
use crate::errors::VaultError;
use crate::constants::MAX_ASSIGNMENTS;
use crate::util::deadline;

/// Reject a plan that bequeaths a mint which is not a real token mint account.
/// An assignment whose `mint` never loads as an `InterfaceAccount<Mint>` (garbage
/// pubkey, wrong network, non-mint address) can never have its paid bit set —
/// `begin_token_dist` and `execute_specific_asset` both require the mint to load —
/// so it would permanently brick `finalize` (which needs the full plan mask) with
/// no post-deadline recovery. We validate at plan-set: every distinct non-sentinel
/// assignment mint must be passed in `remaining_accounts` and load as a
/// token-program-owned Mint. Matched by key against the real on-chain account, so
/// the owner cannot substitute a fake. The SOL sentinel (`Pubkey::default()`) is
/// not a mint and is skipped. NOTE: this is a *set-time* guard — a mint valid here
/// but closed later (Token-2022 CloseMint) is an execution-time concern (A1), not
/// reachable by this check.
pub fn validate_plan_mints(
    assignments: &[AssetAssignment],
    remaining: &[AccountInfo],
) -> Result<()> {
    for a in assignments {
        if a.mint == Pubkey::default() {
            continue; // SOL sentinel — not a mint account
        }
        let ai = remaining
            .iter()
            .find(|ai| ai.key() == a.mint)
            .ok_or(error!(VaultError::InvalidPlanMint))?;
        // Must be owned by a token program AND unpack as a Mint (StateWithExtensions
        // handles both legacy SPL and Token-2022; a legacy mint has no extension TLV).
        require!(
            *ai.owner == anchor_spl::token::ID || *ai.owner == anchor_spl::token_2022::ID,
            VaultError::InvalidPlanMint
        );
        let data = ai.try_borrow_data()?;
        StateWithExtensions::<Mint>::unpack(&data).map_err(|_| error!(VaultError::InvalidPlanMint))?;
    }
    Ok(())
}

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
    validate_plan_mints(&assignments, ctx.remaining_accounts)?;

    let plan = &mut ctx.accounts.asset_plan;
    plan.vault = vault.key();
    plan.assignments = assignments;
    plan.paid_mask = 0;
    plan.bump = ctx.bumps.asset_plan;

    ctx.accounts.vault_config.has_asset_plan = true;

    Ok(())
}
