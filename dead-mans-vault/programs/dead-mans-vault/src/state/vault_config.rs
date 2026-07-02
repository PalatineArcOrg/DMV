use anchor_lang::prelude::*;
use crate::constants::MAX_BENEFICIARIES;

#[account]
pub struct VaultConfig {
    /// Owner wallet pubkey
    pub owner: Pubkey,

    /// Agent's TEE-generated execution pubkey (heartbeats only)
    pub agent_pubkey: Pubkey,

    /// Heartbeat interval in seconds (e.g., 604800 = 7 days)
    pub heartbeat_interval: i64,

    /// Total grace period in seconds from first missed heartbeat to execution
    pub grace_period: i64,

    /// Registered beneficiaries (on-chain whitelist). Index is authoritative —
    /// AssetPlan assignments and paid-masks reference beneficiaries by index.
    pub beneficiaries: Vec<Beneficiary>,

    /// Whether the vault has been executed (prevents double-execution)
    pub executed: bool,

    /// Whether the vault is active (owner can deactivate)
    pub active: bool,

    /// Timestamp when vault was created
    pub created_at: i64,

    /// Timestamp when vault config was last updated
    pub updated_at: i64,

    /// Bump seed for PDA derivation
    pub bump: u8,

    /// Whether the vault can be revoked/updated by the owner (false = immutable)
    pub is_mutable: bool,

    /// Whether a canonical AssetPlan PDA exists for this vault. Set true by
    /// `set_asset_plan`; gates whether execution instructions require the plan.
    pub has_asset_plan: bool,

    /// Number of TokenDist PDAs currently open (incremented by begin_token_dist,
    /// decremented by close_token_dist). The owner-close requires this to be 0 so
    /// a started token distribution can never be orphaned by a premature close.
    pub open_token_dists: u16,

    /// Keeper bounty (lamports) reserved in the vault at init and paid to the
    /// cranker that runs finalize_execution. Carved out of the SOL snapshot at
    /// begin_execution so it never reduces beneficiary payouts. 0 = no bounty.
    /// Taken from the account's existing padding — non-breaking (legacy vaults
    /// deserialize this as 0).
    pub keeper_bounty: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Beneficiary {
    /// Wallet address to receive assets
    pub wallet: Pubkey,

    /// Percentage share (basis points, 10000 = 100%)
    pub share_bps: u16,
}

impl VaultConfig {
    pub const SPACE: usize = 8  // discriminator
        + 32    // owner
        + 32    // agent_pubkey
        + 8     // heartbeat_interval
        + 8     // grace_period
        + 4 + (MAX_BENEFICIARIES * (32 + 2))  // beneficiaries vec (34 B each)
        + 1     // executed
        + 1     // active
        + 8     // created_at
        + 8     // updated_at
        + 1     // bump
        + 1     // is_mutable
        + 1     // has_asset_plan
        + 2     // open_token_dists
        + 8     // keeper_bounty (from former padding — SPACE unchanged)
        + 53;   // padding for future fields
}
