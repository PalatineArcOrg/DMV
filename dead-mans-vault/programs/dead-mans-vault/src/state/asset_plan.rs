use anchor_lang::prelude::*;
use crate::constants::MAX_ASSIGNMENTS;

/// One per vault, fixed-size. Owner-defined specific bequests: SOL (via the
/// zero-pubkey sentinel mint), SPL tokens, and NFTs. Created by `set_asset_plan`
/// (strict `init` at full size), edited by `update_asset_plan` (owner overwrite).
/// Lives on the heap, not the stack.
#[account]
pub struct AssetPlan {
    /// Associated vault config
    pub vault: Pubkey,

    /// Specific-bequest assignments (fixed cap MAX_ASSIGNMENTS)
    pub assignments: Vec<AssetAssignment>,

    /// Bit j set when assignment j has been executed
    pub paid_mask: u64,

    /// Bump seed
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct AssetAssignment {
    /// Mint of the bequeathed asset (SPL/NFT); the zero-pubkey sentinel = a SOL bequest
    pub mint: Pubkey,

    /// Exact base units to transfer; 1 for an NFT
    pub amount: u64,

    /// Index into VaultConfig.beneficiaries
    pub beneficiary_index: u8,

    /// Whether this assignment is a whole NFT (decimals 0, supply 1).
    /// NFT shape is validated client-side (B4) — this flag enforces the
    /// "at most one assignment per NFT mint" rule on-chain.
    pub is_nft: bool,
}

impl AssetAssignment {
    /// 32 mint + 8 amount + 1 beneficiary_index + 1 is_nft
    pub const SIZE: usize = 42;
}

impl AssetPlan {
    pub const SPACE: usize = 8  // discriminator
        + 32                                    // vault
        + 4 + (MAX_ASSIGNMENTS * AssetAssignment::SIZE)  // assignments vec (fixed cap)
        + 8                                     // paid_mask
        + 1;                                    // bump
}
