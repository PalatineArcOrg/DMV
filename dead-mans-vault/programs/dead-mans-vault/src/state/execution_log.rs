use anchor_lang::prelude::*;

/// Created by `begin_execution`. Its mere existence == "execution has begun"
/// (and proves grace was elapsed at that point — downstream permissionless
/// instructions gate on this account existing rather than re-checking grace).
#[account]
pub struct ExecutionLog {
    /// Associated vault config
    pub vault: Pubkey,

    /// Lamports residual for the pro-rata split = (vault balance − rent) − Σ
    /// specific-SOL bequests, frozen at begin_execution. Specific-SOL amounts are
    /// paid separately by execute_specific_sol (carved out here, like token specifics).
    pub sol_snapshot: u64,

    /// Bit i set when beneficiary i has been paid their SOL share.
    pub sol_paid_mask: u32,

    /// Timestamp execution began
    pub started_at: i64,

    /// Whether finalize_execution has run (sol + asset masks full)
    pub completed: bool,

    /// Number of SOL transfers executed (incremented only on 0->1 mask transition)
    pub transfer_count: u32,

    /// Total SOL distributed (in lamports)
    pub total_sol_distributed: u64,

    /// Bump seed
    pub bump: u8,
}

impl ExecutionLog {
    pub const SPACE: usize = 8  // discriminator
        + 32    // vault
        + 8     // sol_snapshot
        + 4     // sol_paid_mask
        + 8     // started_at
        + 1     // completed
        + 4     // transfer_count
        + 8     // total_sol_distributed
        + 1     // bump
        + 64;   // padding
}
