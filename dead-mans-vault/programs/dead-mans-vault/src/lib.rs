use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;
pub mod util;

use instructions::*;
use state::AssetAssignment;

declare_id!("GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb");

#[program]
pub mod dead_mans_vault {
    use super::*;

    // ---- Setup & owner management ----

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

    pub fn rotate_agent(
        ctx: Context<RotateAgent>,
        new_agent_pubkey: Pubkey,
    ) -> Result<()> {
        instructions::rotate_agent::handler(ctx, new_agent_pubkey)
    }

    pub fn revoke_vault(ctx: Context<RevokeVault>) -> Result<()> {
        instructions::revoke_vault::handler(ctx)
    }

    pub fn close_revoked_vault(ctx: Context<CloseRevokedVault>) -> Result<()> {
        instructions::close_revoked_vault::handler(ctx)
    }

    pub fn close_executed_vault_by_owner(ctx: Context<CloseExecutedVaultByOwner>) -> Result<()> {
        instructions::close_executed_vault_by_owner::handler(ctx)
    }

    /// Permissionless keeper cleanup of an executed vault after the
    /// owner-exclusive window — rents → payer, dust → largest-share beneficiary.
    pub fn close_executed_vault(ctx: Context<CloseExecutedVault>) -> Result<()> {
        instructions::close_executed_vault::handler(ctx)
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

    // ---- Specific bequests (owner, pre-grace) ----

    pub fn set_asset_plan(
        ctx: Context<SetAssetPlan>,
        assignments: Vec<AssetAssignment>,
    ) -> Result<()> {
        instructions::set_asset_plan::handler(ctx, assignments)
    }

    pub fn update_asset_plan(
        ctx: Context<UpdateAssetPlan>,
        assignments: Vec<AssetAssignment>,
    ) -> Result<()> {
        instructions::update_asset_plan::handler(ctx, assignments)
    }

    pub fn clear_asset_plan(ctx: Context<ClearAssetPlan>) -> Result<()> {
        instructions::clear_asset_plan::handler(ctx)
    }

    // ---- Permissionless autonomous execution ----

    pub fn begin_execution(ctx: Context<BeginExecution>) -> Result<()> {
        instructions::begin_execution::handler(ctx)
    }

    pub fn begin_token_dist(ctx: Context<BeginTokenDist>) -> Result<()> {
        instructions::begin_token_dist::handler(ctx)
    }

    pub fn execute_specific_asset(
        ctx: Context<ExecuteSpecificAsset>,
        assignment_index: u8,
    ) -> Result<()> {
        instructions::execute_specific_asset::handler(ctx, assignment_index)
    }

    pub fn execute_specific_sol(
        ctx: Context<ExecuteSpecificSol>,
        assignment_index: u8,
    ) -> Result<()> {
        instructions::execute_specific_sol::handler(ctx, assignment_index)
    }

    pub fn execute_sol_shares(
        ctx: Context<ExecuteSolShares>,
        indices: Vec<u8>,
    ) -> Result<()> {
        instructions::execute_sol_shares::handler(ctx, indices)
    }

    pub fn execute_token_shares<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteTokenShares<'info>>,
        indices: Vec<u8>,
    ) -> Result<()> {
        instructions::execute_token_shares::handler(ctx, indices)
    }

    pub fn finalize_execution(ctx: Context<FinalizeExecution>) -> Result<()> {
        instructions::finalize_execution::handler(ctx)
    }

    pub fn close_token_dist(ctx: Context<CloseTokenDist>) -> Result<()> {
        instructions::close_token_dist::handler(ctx)
    }
}
