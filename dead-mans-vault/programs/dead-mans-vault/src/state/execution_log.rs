use anchor_lang::prelude::*;

#[account]
pub struct ExecutionLog {
    /// Associated vault config
    pub vault: Pubkey,

    /// Timestamp of execution
    pub executed_at: i64,

    /// Number of transfers executed
    pub transfer_count: u32,

    /// Total SOL distributed (in lamports)
    pub total_sol_distributed: u64,

    /// Total SPL token types distributed
    pub token_types_distributed: u32,

    /// TEE attestation data hash (32 bytes)
    pub attestation_hash: [u8; 32],

    /// Whether execution completed fully
    pub completed: bool,

    /// Bump seed
    pub bump: u8,
}

impl ExecutionLog {
    pub const SPACE: usize = 8  // discriminator
        + 32    // vault
        + 8     // executed_at
        + 4     // transfer_count
        + 8     // total_sol_distributed
        + 4     // token_types_distributed
        + 32    // attestation_hash
        + 1     // completed
        + 1     // bump
        + 64;   // padding
}
