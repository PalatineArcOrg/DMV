use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{Mint, TokenAccount};
use crate::state::{VaultConfig, ExecutionLog, AssetPlan, TokenDist};
use crate::errors::VaultError;

/// Permissionless. Strict `init` — freezes the pro-rata residual for `mint`
/// write-once. Gated by `execution_log` existing (proves grace, per B1); no
/// active/executed check (P4 — token ix run even post-finalize).
///
/// B3: the vault ATA is passed as an UncheckedAccount pinned to the canonical
/// associated-token address so a caller cannot spoof an empty/foreign account
/// to freeze a wrong (e.g. zero) snapshot. A genuinely-absent ATA reads as 0.
///
/// The ATA program id is derived from the mint's OWNER (the true token program),
/// never a caller-supplied account — otherwise an attacker could pass the wrong
/// token program, derive a bogus empty address, and freeze a zero snapshot for a
/// held mint, redirecting its entire residual on close (review CRITICAL).
#[derive(Accounts)]
pub struct BeginTokenDist<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault_config.owner.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        seeds = [b"execution", vault_config.key().as_ref()],
        bump = execution_log.bump,
        constraint = execution_log.vault == vault_config.key() @ VaultError::HeartbeatVaultMismatch,
    )]
    pub execution_log: Account<'info, ExecutionLog>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// The vault's canonical associated token account for `mint`. May not exist.
    /// CHECK: address pinned to the derived ATA below; balance read defensively.
    pub vault_ata: UncheckedAccount<'info>,

    /// Required iff `vault_config.has_asset_plan` (P1).
    #[account(
        seeds = [b"asset_plan", vault_config.key().as_ref()],
        bump,
    )]
    pub asset_plan: Option<Account<'info, AssetPlan>>,

    #[account(
        init,
        payer = payer,
        space = TokenDist::SPACE,
        seeds = [b"token_dist", vault_config.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub token_dist: Account<'info, TokenDist>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<BeginTokenDist>) -> Result<()> {
    let vault_key = ctx.accounts.vault_config.key();
    let mint_key = ctx.accounts.mint.key();

    // Pin the ATA to the canonical derived address. The token program id MUST
    // come from the mint's real owner, not a caller-supplied account.
    let token_program_id = *ctx.accounts.mint.to_account_info().owner;
    let expected_ata =
        get_associated_token_address_with_program_id(&vault_key, &mint_key, &token_program_id);
    require!(
        ctx.accounts.vault_ata.key() == expected_ata,
        VaultError::InvalidVaultAta
    );

    // Read the balance defensively — 0 if the ATA was never created (P11).
    let bal: u64 = {
        let ai = ctx.accounts.vault_ata.to_account_info();
        if ai.data_is_empty() {
            0
        } else {
            let data = ai.try_borrow_data()?;
            let acc = TokenAccount::try_deserialize(&mut &data[..])?;
            require!(
                acc.mint == mint_key && acc.owner == vault_key,
                VaultError::TokenAccountMismatch
            );
            acc.amount
        }
    };

    // Sum of specific bequests for this mint (carved out of the residual) plus
    // whether the mint appears in the plan at all.
    let mut spec_sum: u64 = 0;
    let mut mint_in_plan = false;
    if ctx.accounts.vault_config.has_asset_plan {
        let plan = ctx
            .accounts
            .asset_plan
            .as_ref()
            .ok_or(error!(VaultError::AssetPlanRequired))?;
        require!(plan.vault == vault_key, VaultError::AssetPlanRequired);
        for a in plan.assignments.iter().filter(|a| a.mint == mint_key) {
            mint_in_plan = true;
            spec_sum = spec_sum.saturating_add(a.amount);
        }
    }

    // Anti-grief: refuse to open a distribution for a mint the vault neither holds
    // nor bequeaths. Such a TokenDist snapshots 0 yet still increments
    // open_token_dists, which close_executed_vault_by_owner requires to be 0 —
    // letting anyone spam junk mints to block the owner's rent reclaim. Held mints
    // (bal > 0) and bequeathed-but-unheld mints (in the plan) stay valid.
    require!(bal > 0 || mint_in_plan, VaultError::NothingToDistribute);

    let dist = &mut ctx.accounts.token_dist;
    dist.vault = vault_key;
    dist.mint = mint_key;
    dist.snapshot = bal.saturating_sub(spec_sum);
    dist.paid_mask = 0;
    dist.bump = ctx.bumps.token_dist;

    // Track the open distribution so the owner-close can't orphan it (R9).
    let vault = &mut ctx.accounts.vault_config;
    vault.open_token_dists = vault.open_token_dists.saturating_add(1);

    Ok(())
}
