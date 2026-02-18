use anchor_lang::prelude::*;
use crate::state::VaultConfig;
use crate::errors::VaultError;

#[derive(Accounts)]
pub struct RevokeVault<'info> {
    /// Only the owner can revoke
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ VaultError::UnauthorizedOwner,
        constraint = !vault_config.executed @ VaultError::VaultAlreadyExecuted,
        constraint = vault_config.is_mutable @ VaultError::VaultImmutable,
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

pub fn handler(ctx: Context<RevokeVault>) -> Result<()> {
    let vault = &mut ctx.accounts.vault_config;
    vault.active = false;

    msg!("Vault revoked by owner. Agent authority removed.");
    Ok(())
}
