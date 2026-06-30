use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{
    close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
    TransferChecked,
};
use crate::state::{VaultConfig, TokenDist};
use crate::errors::VaultError;
use crate::constants::full_mask_u32;
use crate::util::largest_share_index;

/// Permissionless. After all of a token's residual is paid, sweep any rounding
/// dust to the largest-share beneficiary, close the vault ATA (rent → owner),
/// and close the TokenDist (rent → cranker). Must run for every held mint before
/// the owner closes the core PDAs.
#[derive(Accounts)]
pub struct CloseTokenDist<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Owner receives the ATA rent on close.
    /// CHECK: pinned to vault_config.owner.
    #[account(
        mut,
        constraint = owner.key() == vault_config.owner @ VaultError::UnauthorizedOwner,
    )]
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"vault", vault_config.owner.as_ref()],
        bump = vault_config.bump,
        constraint = vault_config.executed @ VaultError::VaultNotExecuted,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = vault_ata.owner == vault_config.key() @ VaultError::TokenAccountMismatch,
        constraint = vault_ata.mint == mint.key() @ VaultError::TokenAccountMismatch,
    )]
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"token_dist", vault_config.key().as_ref(), mint.key().as_ref()],
        bump = token_dist.bump,
        constraint = token_dist.vault == vault_config.key() @ VaultError::MintMismatch,
        close = payer,
    )]
    pub token_dist: Account<'info, TokenDist>,

    /// Required only when there is dust to sweep (vault_ata.amount > 0).
    #[account(mut)]
    pub largest_benef_ata: Option<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<CloseTokenDist>) -> Result<()> {
    let vault = &ctx.accounts.vault_config;

    // All beneficiary residual shares must be paid before closing.
    require!(
        ctx.accounts.token_dist.paid_mask == full_mask_u32(vault.beneficiaries.len()),
        VaultError::NotAllSharesPaid
    );

    let owner_key = vault.owner;
    let bump = vault.bump;
    let mint_key = ctx.accounts.mint.key();
    let decimals = ctx.accounts.mint.decimals;
    let dust = ctx.accounts.vault_ata.amount;

    // Defense-in-depth: operate on the same canonical ATA that begin_token_dist
    // snapshotted (derived from the mint's real owner), not any vault-owned
    // account for this mint.
    let token_program_id = *ctx.accounts.mint.to_account_info().owner;
    let expected_ata =
        get_associated_token_address_with_program_id(&vault.key(), &mint_key, &token_program_id);
    require!(
        ctx.accounts.vault_ata.key() == expected_ata,
        VaultError::InvalidVaultAta
    );

    let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[bump]];
    let signer = &[seeds];

    // Sweep dust to the largest-share beneficiary (ties → lowest index).
    if dust > 0 {
        let max_idx = largest_share_index(&vault.beneficiaries);
        let max_wallet = vault.beneficiaries[max_idx].wallet;
        let dust_ata = ctx
            .accounts
            .largest_benef_ata
            .as_ref()
            .ok_or(error!(VaultError::TokenAccountMismatch))?;
        require!(
            dust_ata.owner == max_wallet && dust_ata.mint == mint_key,
            VaultError::TokenAccountMismatch
        );

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: dust_ata.to_account_info(),
                authority: ctx.accounts.vault_config.to_account_info(),
            },
            signer,
        );
        transfer_checked(cpi, dust, decimals)?;
    }

    // Close the emptied vault ATA, returning its rent to the owner.
    let cpi = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault_ata.to_account_info(),
            destination: ctx.accounts.owner.to_account_info(),
            authority: ctx.accounts.vault_config.to_account_info(),
        },
        signer,
    );
    close_account(cpi)?;

    // One fewer open distribution to account for at owner-close.
    let vault = &mut ctx.accounts.vault_config;
    vault.open_token_dists = vault.open_token_dists.saturating_sub(1);

    Ok(())
}
