use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::VaultConfig;
use crate::errors::VaultError;

#[derive(Accounts)]
pub struct WithdrawFromVault<'info> {
    /// Owner signs — only the vault owner can withdraw deposited tokens
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
    )]
    pub vault_config: Account<'info, VaultConfig>,

    /// Vault PDA's token account to withdraw FROM — must be owned by the vault PDA
    #[account(
        mut,
        constraint = source_token_account.owner == vault_config.key() @ VaultError::UnauthorizedOwner,
    )]
    pub source_token_account: Account<'info, TokenAccount>,

    /// Owner's token account to withdraw TO — must match the same mint
    #[account(
        mut,
        constraint = destination_token_account.mint == source_token_account.mint @ VaultError::UnregisteredBeneficiary,
    )]
    pub destination_token_account: Account<'info, TokenAccount>,

    /// Vault PDA as signing authority for the token transfer.
    /// CHECK: Derived from ["vault", owner] seeds. Verified by seeds + bump
    /// constraint. No data deserialization needed — only PDA signature.
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WithdrawFromVault>, amount: u64) -> Result<()> {
    let owner_key = ctx.accounts.vault_config.owner;
    let bump = ctx.accounts.vault_config.bump;
    let seeds = &[
        b"vault".as_ref(),
        owner_key.as_ref(),
        &[bump],
    ];
    let signer_seeds = &[&seeds[..]];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.source_token_account.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        },
        signer_seeds,
    );

    token::transfer(transfer_ctx, amount)?;

    Ok(())
}
