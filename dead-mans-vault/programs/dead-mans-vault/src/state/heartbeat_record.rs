use anchor_lang::prelude::*;

#[account]
pub struct HeartbeatRecord {
    /// Associated vault config
    pub vault: Pubkey,

    /// Timestamp of last confirmed heartbeat (Unix epoch)
    pub last_heartbeat: i64,

    /// Method used for last heartbeat
    pub last_method: HeartbeatMethod,

    /// Total heartbeats recorded
    pub total_heartbeats: u64,

    /// Bump seed
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum HeartbeatMethod {
    ActiveTap,
    BiometricConfirm,
    OnChainActivity,
    PinChallenge,
    HardwareSwitch,
}

impl HeartbeatRecord {
    pub const SPACE: usize = 8  // discriminator
        + 32    // vault
        + 8     // last_heartbeat
        + 1     // last_method (enum)
        + 8     // total_heartbeats
        + 1     // bump
        + 32;   // padding
}
