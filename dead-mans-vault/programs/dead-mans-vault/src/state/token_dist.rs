use anchor_lang::prelude::*;

/// One per (vault, mint). Created by `begin_token_dist`, which freezes the
/// pro-rata residual (ATA balance minus the sum of specific bequests for this
/// mint) write-once via strict `init`. Closed by `close_token_dist`.
#[account]
pub struct TokenDist {
    /// Associated vault config
    pub vault: Pubkey,

    /// The mint this distribution tracks
    pub mint: Pubkey,

    /// Residual = ata_balance - Σspecific(mint), frozen at begin_token_dist
    pub snapshot: u64,

    /// Bit i set when beneficiary i has been paid this token's residual share
    pub paid_mask: u32,

    /// Bump seed
    pub bump: u8,
}

impl TokenDist {
    pub const SPACE: usize = 8  // discriminator
        + 32    // vault
        + 32    // mint
        + 8     // snapshot
        + 4     // paid_mask
        + 1     // bump
        + 32;   // padding
}
