use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb");

#[program]
pub mod dead_mans_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        params: InitializeVaultParams,
    ) -> Result<()> {
        instructions::initialize_vault::handler(ctx, params)
    }

    pub fn update_vault(
        ctx: Context<UpdateVault>,
        params: UpdateVaultParams,
    ) -> Result<()> {
        instructions::update_vault::handler(ctx, params)
    }

    pub fn record_heartbeat(
        ctx: Context<RecordHeartbeat>,
        method: state::HeartbeatMethod,
    ) -> Result<()> {
        instructions::record_heartbeat::handler(ctx, method)
    }

    pub fn execute_distribution(
        ctx: Context<ExecuteDistribution>,
        amount: u64,
        attestation_hash: [u8; 32],
    ) -> Result<()> {
        instructions::execute_distribution::handler(ctx, amount, attestation_hash)
    }

    pub fn execute_sol_distribution(
        ctx: Context<ExecuteSolDistribution>,
        amount: u64,
    ) -> Result<()> {
        instructions::execute_sol_distribution::handler(ctx, amount)
    }

    pub fn record_execution(
        ctx: Context<RecordExecution>,
        params: RecordExecutionParams,
    ) -> Result<()> {
        instructions::record_execution::handler(ctx, params)
    }

    pub fn revoke_vault(ctx: Context<RevokeVault>) -> Result<()> {
        instructions::revoke_vault::handler(ctx)
    }

    pub fn close_revoked_vault(ctx: Context<CloseRevokedVault>) -> Result<()> {
        instructions::close_revoked_vault::handler(ctx)
    }

    pub fn rotate_agent(
        ctx: Context<RotateAgent>,
        new_agent_pubkey: Pubkey,
    ) -> Result<()> {
        instructions::rotate_agent::handler(ctx, new_agent_pubkey)
    }

    pub fn withdraw_from_vault(
        ctx: Context<WithdrawFromVault>,
        amount: u64,
    ) -> Result<()> {
        instructions::withdraw_from_vault::handler(ctx, amount)
    }

    pub fn withdraw_sol_from_vault(
        ctx: Context<WithdrawSolFromVault>,
        amount: u64,
    ) -> Result<()> {
        instructions::withdraw_sol_from_vault::handler(ctx, amount)
    }

    pub fn close_executed_vault(ctx: Context<CloseExecutedVault>) -> Result<()> {
        instructions::close_executed_vault::handler(ctx)
    }

    pub fn close_executed_vault_by_owner(ctx: Context<CloseExecutedVaultByOwner>) -> Result<()> {
        instructions::close_executed_vault_by_owner::handler(ctx)
    }
}
