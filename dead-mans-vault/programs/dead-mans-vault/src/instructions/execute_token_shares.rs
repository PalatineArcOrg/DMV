use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use crate::state::{VaultConfig, TokenDist};
use crate::errors::VaultError;

/// Permissionless, batched. Pays each beneficiary's pro-rata share of a token's
/// residual. `remaining_accounts` are the matching beneficiary ATAs, same order.
/// Gated by `token_dist` existing (which required grace at begin_token_dist), so
/// it is safe to run after finalize (P4). Idempotent via the paid-mask.
#[derive(Accounts)]
pub struct ExecuteTokenShares<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"vault", vault_config.owner.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    #[account(
        mut,
        seeds = [b"token_dist", vault_config.key().as_ref(), mint.key().as_ref()],
        bump = token_dist.bump,
        constraint = token_dist.vault == vault_config.key() @ VaultError::MintMismatch,
    )]
    pub token_dist: Account<'info, TokenDist>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = vault_ata.owner == vault_config.key() @ VaultError::TokenAccountMismatch,
        constraint = vault_ata.mint == mint.key() @ VaultError::TokenAccountMismatch,
    )]
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, ExecuteTokenShares<'info>>,
    indices: Vec<u8>,
) -> Result<()> {
    require!(
        indices.len() == ctx.remaining_accounts.len(),
        VaultError::AccountCountMismatch
    );

    let mint_key = ctx.accounts.mint.key();
    let vault_key = ctx.accounts.vault_config.key();
    let owner_key = ctx.accounts.vault_config.owner;
    let bump = ctx.accounts.vault_config.bump;
    let decimals = ctx.accounts.mint.decimals;

    // Defense-in-depth: pin to the canonical ATA that begin_token_dist snapshotted.
    let token_program_id = *ctx.accounts.mint.to_account_info().owner;
    let expected_ata =
        get_associated_token_address_with_program_id(&vault_key, &mint_key, &token_program_id);
    require!(
        ctx.accounts.vault_ata.key() == expected_ata,
        VaultError::InvalidVaultAta
    );
    let benefs: Vec<(Pubkey, u16)> = ctx
        .accounts
        .vault_config
        .beneficiaries
        .iter()
        .map(|b| (b.wallet, b.share_bps))
        .collect();
    let snapshot = ctx.accounts.token_dist.snapshot as u128;

    for (k, idx) in indices.iter().enumerate() {
        let i = *idx as usize;
        require!(i < benefs.len(), VaultError::InvalidBeneficiaryIndex);

        if ctx.accounts.token_dist.paid_mask & (1u32 << i) != 0 {
            continue;
        }

        let ai = ctx.remaining_accounts[k].clone();
        require!(ai.is_writable, VaultError::TokenAccountMismatch);
        {
            let data = ai.try_borrow_data()?;
            let ben_ata = TokenAccount::try_deserialize(&mut &data[..])?;
            require!(
                ben_ata.owner == benefs[i].0 && ben_ata.mint == mint_key,
                VaultError::TokenAccountMismatch
            );
        }

        let amt = (snapshot * (benefs[i].1 as u128) / 10_000u128) as u64;

        // Effect before interaction (CEI): record the payout before the transfer
        // CPI so a Token-2022 transfer hook cannot re-enter for the same index and
        // double-pay. On CPI failure the whole tx reverts, rolling this back.
        ctx.accounts.token_dist.paid_mask |= 1u32 << i;

        if amt > 0 {
            let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[bump]];
            let signer = &[seeds];
            let cpi = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ai,
                    authority: ctx.accounts.vault_config.to_account_info(),
                },
                signer,
            );
            transfer_checked(cpi, amt, decimals)?;
        }
    }

    Ok(())
}
