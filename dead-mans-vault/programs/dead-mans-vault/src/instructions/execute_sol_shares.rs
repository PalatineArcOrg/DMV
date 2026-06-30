use anchor_lang::prelude::*;
use crate::state::{VaultConfig, ExecutionLog};
use crate::errors::VaultError;

/// Permissionless, batched. Pays the SOL pro-rata share to each beneficiary in
/// `indices`. `remaining_accounts` are the matching beneficiary wallets, in the
/// same order. Grace is proven by `execution_log` existing (B1). Idempotent:
/// already-paid indices are skipped, so concurrent/overlapping cranks are safe.
#[derive(Accounts)]
pub struct ExecuteSolShares<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault_config.owner.as_ref()],
        bump = vault_config.bump,
        constraint = !vault_config.executed @ VaultError::VaultAlreadyExecuted,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        mut,
        seeds = [b"execution", vault_config.key().as_ref()],
        bump = execution_log.bump,
        constraint = execution_log.vault == vault_config.key() @ VaultError::HeartbeatVaultMismatch,
    )]
    pub execution_log: Account<'info, ExecutionLog>,
}

pub fn handler(ctx: Context<ExecuteSolShares>, indices: Vec<u8>) -> Result<()> {
    require!(
        indices.len() == ctx.remaining_accounts.len(),
        VaultError::AccountCountMismatch
    );

    let vault_key = ctx.accounts.vault_config.key();
    let benefs: Vec<(Pubkey, u16)> = ctx
        .accounts
        .vault_config
        .beneficiaries
        .iter()
        .map(|b| (b.wallet, b.share_bps))
        .collect();
    let snapshot = ctx.accounts.execution_log.sol_snapshot as u128;

    let vault_info = ctx.accounts.vault_config.to_account_info();

    for (k, idx) in indices.iter().enumerate() {
        let i = *idx as usize;
        require!(i < benefs.len(), VaultError::InvalidBeneficiaryIndex);

        // Idempotent skip — don't fail the batch on an already-paid index.
        if ctx.accounts.execution_log.sol_paid_mask & (1u32 << i) != 0 {
            continue;
        }

        let w = &ctx.remaining_accounts[k];
        require!(w.key() == benefs[i].0, VaultError::BeneficiaryMismatch);
        require!(w.is_writable, VaultError::TokenAccountMismatch);

        let amt = (snapshot * (benefs[i].1 as u128) / 10_000u128) as u64;
        if amt > 0 {
            require!(w.key() != vault_key, VaultError::BeneficiaryMismatch);

            **vault_info.try_borrow_mut_lamports()? = vault_info
                .lamports()
                .checked_sub(amt)
                .ok_or(VaultError::InsufficientVaultBalance)?;
            **w.try_borrow_mut_lamports()? = w
                .lamports()
                .checked_add(amt)
                .ok_or(VaultError::InsufficientVaultBalance)?;

            let log = &mut ctx.accounts.execution_log;
            log.total_sol_distributed = log.total_sol_distributed.saturating_add(amt);
            log.transfer_count = log.transfer_count.saturating_add(1);
        }

        ctx.accounts.execution_log.sol_paid_mask |= 1u32 << i;
    }

    Ok(())
}
