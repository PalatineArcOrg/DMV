/// Minimum heartbeat interval: 10 seconds (devnet demo-friendly).
/// MAINNET: Restore to 86_400 (1 day) before mainnet deployment.
pub const MIN_HEARTBEAT_INTERVAL: i64 = 10;

/// Minimum grace period: 30 seconds (devnet demo-friendly).
/// MAINNET: Restore to 604_800 (7 days) before mainnet deployment.
pub const MIN_GRACE_PERIOD: i64 = 30;

/// Maximum beneficiaries per vault
pub const MAX_BENEFICIARIES: usize = 20;
