use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, CloseAccount};
use crate::state::VaultConfig;
use crate::errors::VaultError;

/// Closes an EMPTY token account owned by the vault PDA and returns its
/// rent-exempt lamports to the owner. Used after `withdraw_from_vault` has
/// drained the balance to zero so the ATA rent (~0.002 SOL/mint) isn't
/// stranded when the vault is revoked. The SPL Token program's CloseAccount
/// requires a zero balance, so this fails safely if tokens remain.
#[derive(Accounts)]
pub struct CloseVaultAta<'info> {
    /// Owner signs and receives the reclaimed ATA rent
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    /// Vault PDA's token account to close — must be owned by the vault PDA
    #[account(
        mut,
        constraint = vault_token_account.owner == vault_config.key() @ VaultError::UnauthorizedOwner,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Vault PDA as the close authority.
    /// CHECK: Derived from ["vault", owner] seeds. Verified by seeds + bump
    /// constraint. No data deserialization needed — only PDA signature.
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CloseVaultAta>) -> Result<()> {
    let owner_key = ctx.accounts.vault_config.owner;
    let bump = ctx.accounts.vault_config.bump;
    let seeds = &[
        b"vault".as_ref(),
        owner_key.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];

    let close_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault_token_account.to_account_info(),
            destination: ctx.accounts.owner.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer_seeds,
    );

    token::close_account(close_ctx)?;

    Ok(())
}
