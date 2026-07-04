use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use crate::state::{VaultConfig, ExecutionLog, AssetPlan, TokenDist};
use crate::errors::VaultError;
use crate::util::lower_index_same_mint_mask;

/// Permissionless. Pays one specific bequest (SPL token / NFT). Grace is proven
/// by `execution_log` existing (B1); ordering is enforced by `token_dist` having
/// been created first. The beneficiary is pinned by index-equality on its ATA.
#[derive(Accounts)]
pub struct ExecuteSpecificAsset<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
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

    #[account(
        mut,
        seeds = [b"asset_plan", vault_config.key().as_ref()],
        bump = asset_plan.bump,
        constraint = asset_plan.vault == vault_config.key() @ VaultError::AssetPlanRequired,
    )]
    pub asset_plan: Account<'info, AssetPlan>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// Must already exist — its presence gates execution order (§2).
    #[account(
        seeds = [b"token_dist", vault_config.key().as_ref(), mint.key().as_ref()],
        bump = token_dist.bump,
        constraint = token_dist.vault == vault_config.key() @ VaultError::MintMismatch,
    )]
    pub token_dist: Account<'info, TokenDist>,

    #[account(mut)]
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub beneficiary_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<ExecuteSpecificAsset>, assignment_index: u8) -> Result<()> {
    let vault = &ctx.accounts.vault_config;
    let plan = &ctx.accounts.asset_plan;
    let mint_key = ctx.accounts.mint.key();

    // 2. bounds
    let j = assignment_index as usize;
    require!(j < plan.assignments.len(), VaultError::InvalidBeneficiaryIndex);

    // 3. load (Copy)
    let a = plan.assignments[j];

    // This is the SPL/NFT path only. A SOL bequest (zero-pubkey sentinel mint)
    // must be paid via execute_specific_sol, not here.
    require!(a.mint != Pubkey::default(), VaultError::MintMismatch);

    // 4. beneficiary index in range
    let bi = a.beneficiary_index as usize;
    require!(bi < vault.beneficiaries.len(), VaultError::InvalidBeneficiaryIndex);
    let benef_wallet = vault.beneficiaries[bi].wallet;

    // 5 + 8. index-equality: the beneficiary ATA must be owned by exactly the
    // beneficiary registered at this index, and hold this mint.
    require!(
        ctx.accounts.beneficiary_ata.owner == benef_wallet,
        VaultError::BeneficiaryMismatch
    );
    require!(
        ctx.accounts.beneficiary_ata.mint == a.mint,
        VaultError::TokenAccountMismatch
    );

    // 6. mint pinned to the assignment
    require!(mint_key == a.mint, VaultError::MintMismatch);

    // 7. vault ATA owned by the vault and holding this mint
    require!(
        ctx.accounts.vault_ata.owner == vault.key() && ctx.accounts.vault_ata.mint == a.mint,
        VaultError::TokenAccountMismatch
    );

    // 7b. Pin the vault ATA to its canonical associated-token address, derived
    // from the mint's TRUE owner program — the same anti-spoof guard already used
    // by begin_token_dist / execute_token_shares / close_token_dist. Without it a
    // permissionless caller could pass a different (e.g. attacker-created, empty)
    // vault-owned token account for this mint: the transfer would move
    // min(amount, 0) = 0, the paid bit would still be set, and the intended heir
    // would be denied their bequest — the asset then leaks to the largest-share
    // beneficiary as dust on close. begin_token_dist snapshots from THIS canonical
    // ATA, so the specific-payout source must be the same account.
    let token_program_id = *ctx.accounts.mint.to_account_info().owner;
    let expected_ata =
        get_associated_token_address_with_program_id(&vault.key(), &mint_key, &token_program_id);
    require!(
        ctx.accounts.vault_ata.key() == expected_ata,
        VaultError::InvalidVaultAta
    );

    // 9. in-order: every lower-index assignment for THIS mint already paid
    let lower = lower_index_same_mint_mask(plan, a.mint, j);
    require!(plan.paid_mask & lower == lower, VaultError::SpecificOutOfOrder);

    // 10. not already paid
    require!(plan.paid_mask & (1u64 << j) == 0, VaultError::MaskAlreadySet);

    // 11. defensive: beneficiary is not the vault PDA itself
    require!(benef_wallet != vault.key(), VaultError::BeneficiaryMismatch);

    // Compute the payout, then record it BEFORE the transfer (checks-effects-
    // interactions): a Token-2022 transfer hook runs arbitrary code during the
    // CPI, so setting the paid bit first removes any same-index reentrancy path.
    // On CPI failure the whole tx reverts, rolling the bit back atomically. Always
    // set the bit so finalize stays reachable even for an underfunded assignment.
    let amt = a.amount.min(ctx.accounts.vault_ata.amount);
    ctx.accounts.asset_plan.paid_mask |= 1u64 << j;

    if amt > 0 {
        let owner_key = vault.owner;
        let bump = vault.bump;
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[bump]];
        let signer = &[seeds];
        let decimals = ctx.accounts.mint.decimals;
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.beneficiary_ata.to_account_info(),
                authority: ctx.accounts.vault_config.to_account_info(),
            },
            signer,
        );
        transfer_checked(cpi, amt, decimals)?;
    }

    Ok(())
}
