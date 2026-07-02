use anchor_lang::prelude::*;
use crate::state::{VaultConfig, ExecutionLog, AssetPlan};
use crate::errors::VaultError;
use crate::util::lower_index_same_mint_mask;

/// Permissionless. Pays one specific *SOL* bequest — an AssetPlan assignment
/// whose `mint` is the zero-pubkey sentinel. Grace is proven by `execution_log`
/// existing (B1). The beneficiary wallet is pinned by index-equality, the
/// specific amount was carved out of the pro-rata residual at begin_execution,
/// and lamports are moved by direct debit (no CPI, no ATAs) — which is why this
/// is a separate instruction from execute_specific_asset (token accounts vs a
/// bare lamport account cannot be conditionally required in one instruction).
#[derive(Accounts)]
pub struct ExecuteSpecificSol<'info> {
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

    #[account(
        mut,
        seeds = [b"asset_plan", vault_config.key().as_ref()],
        bump = asset_plan.bump,
        constraint = asset_plan.vault == vault_config.key() @ VaultError::AssetPlanRequired,
    )]
    pub asset_plan: Account<'info, AssetPlan>,

    /// CHECK: pinned in the handler by index-equality to
    /// `beneficiaries[assignment.beneficiary_index].wallet`.
    #[account(mut)]
    pub beneficiary: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<ExecuteSpecificSol>, assignment_index: u8) -> Result<()> {
    let vault = &ctx.accounts.vault_config;
    let plan = &ctx.accounts.asset_plan;

    // bounds
    let j = assignment_index as usize;
    require!(j < plan.assignments.len(), VaultError::InvalidBeneficiaryIndex);

    // load (Copy)
    let a = plan.assignments[j];

    // SOL path only — assignment must be the zero-pubkey sentinel mint.
    require!(a.mint == Pubkey::default(), VaultError::MintMismatch);

    // beneficiary index in range
    let bi = a.beneficiary_index as usize;
    require!(bi < vault.beneficiaries.len(), VaultError::InvalidBeneficiaryIndex);
    let benef_wallet = vault.beneficiaries[bi].wallet;

    // index-equality: the provided account is exactly the beneficiary at this index
    require!(
        ctx.accounts.beneficiary.key() == benef_wallet,
        VaultError::BeneficiaryMismatch
    );
    // defensive: never the vault PDA itself
    require!(benef_wallet != vault.key(), VaultError::BeneficiaryMismatch);

    // in-order: every lower-index SOL sentinel assignment already paid
    let lower = lower_index_same_mint_mask(plan, Pubkey::default(), j);
    require!(plan.paid_mask & lower == lower, VaultError::SpecificOutOfOrder);

    // not already paid
    require!(plan.paid_mask & (1u64 << j) == 0, VaultError::MaskAlreadySet);

    // Pay min(amount, available above rent); always set the bit so finalize stays
    // reachable (mirrors execute_specific_asset's graceful-underfunding behaviour).
    let vault_info = vault.to_account_info();
    let rent_min = Rent::get()?.minimum_balance(vault_info.data_len());
    let available = vault_info.lamports().saturating_sub(rent_min);
    let amt = a.amount.min(available);
    if amt > 0 {
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(amt)
            .ok_or(VaultError::InsufficientVaultBalance)?;
        **ctx.accounts.beneficiary.try_borrow_mut_lamports()? = ctx
            .accounts
            .beneficiary
            .lamports()
            .checked_add(amt)
            .ok_or(VaultError::InsufficientVaultBalance)?;
    }

    ctx.accounts.asset_plan.paid_mask |= 1u64 << j;

    Ok(())
}
