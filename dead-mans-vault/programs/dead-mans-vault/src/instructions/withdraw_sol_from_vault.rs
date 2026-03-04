use anchor_lang::prelude::*;
use crate::state::VaultConfig;
use crate::errors::VaultError;

#[derive(Accounts)]
pub struct WithdrawSolFromVault<'info> {
    /// Owner signs — only the vault owner can withdraw deposited SOL
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The vault PDA holds both config data AND deposited SOL.
    /// Lamports above rent-exemption are available for withdrawal.
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault_config.bump,
        has_one = owner @ VaultError::UnauthorizedOwner,
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

pub fn handler(ctx: Context<WithdrawSolFromVault>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InsufficientVaultBalance);

    let vault_info = ctx.accounts.vault_config.to_account_info();
    let owner_info = ctx.accounts.owner.to_account_info();

    // Ensure vault retains enough lamports for rent exemption
    let rent = Rent::get()?;
    let min_balance = rent.minimum_balance(vault_info.data_len());
    let available = vault_info.lamports()
        .checked_sub(min_balance)
        .ok_or(VaultError::InsufficientVaultBalance)?;
    require!(amount <= available, VaultError::InsufficientVaultBalance);

    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(amount)
        .ok_or(VaultError::InsufficientVaultBalance)?;
    **owner_info.try_borrow_mut_lamports()? = owner_info
        .lamports()
        .checked_add(amount)
        .ok_or(VaultError::InsufficientVaultBalance)?;

    Ok(())
}
