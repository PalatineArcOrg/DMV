use anchor_lang::prelude::*;
use crate::constants::MAX_BENEFICIARIES;

#[account]
pub struct VaultConfig {
    /// Owner wallet pubkey
    pub owner: Pubkey,

    /// Agent's TEE-generated execution pubkey
    pub agent_pubkey: Pubkey,

    /// Heartbeat interval in seconds (e.g., 604800 = 7 days)
    pub heartbeat_interval: i64,

    /// Total grace period in seconds from first missed heartbeat to execution
    pub grace_period: i64,

    /// Registered beneficiaries (on-chain whitelist)
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
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Beneficiary {
    /// Wallet address to receive assets
    pub wallet: Pubkey,

    /// Percentage share (basis points, 10000 = 100%)
    pub share_bps: u16,

    /// Whether this beneficiary has specific asset assignments
    pub has_specific_assets: bool,
}

impl VaultConfig {
    pub const SPACE: usize = 8  // discriminator
        + 32    // owner
        + 32    // agent_pubkey
        + 8     // heartbeat_interval
        + 8     // grace_period
        + 4 + (MAX_BENEFICIARIES * (32 + 2 + 1))  // beneficiaries vec
        + 1     // executed
        + 1     // active
        + 8     // created_at
        + 8     // updated_at
        + 1     // bump
        + 1     // is_mutable
        + 63;   // padding for future fields
}
