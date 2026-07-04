use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use crate::state::{VaultConfig, HeartbeatRecord};
use crate::errors::VaultError;
use crate::util::deadline;

/// Pre-grace owner withdrawal of an SPL / Token-2022 token from the vault PDA back
/// to the owner. Uses the token interface so it works with both token programs,
/// consistent with deposit and permissionless distribution. Frozen once grace
/// elapses (the snapshot then belongs to the beneficiaries).
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

    #[account(
        seeds = [b"heartbeat", vault_config.key().as_ref()],
        bump = heartbeat_record.bump,
        constraint = heartbeat_record.vault == vault_config.key() @ VaultError::HeartbeatVaultMismatch,
    )]
    pub heartbeat_record: Account<'info, HeartbeatRecord>,

    /// The mint being withdrawn (provides decimals for transfer_checked; its owner
    /// program must be the token program used).
    pub mint: InterfaceAccount<'info, Mint>,

    /// Vault PDA's token account to withdraw FROM — must be owned by the vault PDA
    /// and hold this mint. The vault PDA (vault_config) is the transfer authority.
    #[account(
        mut,
        constraint = source_token_account.owner == vault_config.key() @ VaultError::UnauthorizedOwner,
        constraint = source_token_account.mint == mint.key() @ VaultError::MintMismatch,
    )]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Owner's token account to withdraw TO — must match the same mint.
    #[account(
        mut,
        constraint = destination_token_account.mint == mint.key() @ VaultError::MintMismatch,
    )]
    pub destination_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<WithdrawFromVault>, amount: u64) -> Result<()> {
    // Freeze once grace has elapsed (R8/B1).
    {
        let now = Clock::get()?.unix_timestamp;
        let v = &ctx.accounts.vault_config;
        let dl = deadline(
            ctx.accounts.heartbeat_record.last_heartbeat,
            v.heartbeat_interval,
            v.grace_period,
        )?;
        require!(now < dl, VaultError::VaultFrozen);
    }

    // The token program must be the mint's real owner program (legacy Token vs
    // Token-2022). transfer_checked would fail otherwise, but reject early with a
    // clear error.
    require!(
        ctx.accounts.token_program.key() == *ctx.accounts.mint.to_account_info().owner,
        VaultError::TokenAccountMismatch
    );

    let owner_key = ctx.accounts.vault_config.owner;
    let bump = ctx.accounts.vault_config.bump;
    let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[bump]];
    let signer = &[seeds];
    let decimals = ctx.accounts.mint.decimals;

    let cpi = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.source_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            authority: ctx.accounts.vault_config.to_account_info(),
        },
        signer,
    );

    transfer_checked(cpi, amount, decimals)?;

    Ok(())
}
