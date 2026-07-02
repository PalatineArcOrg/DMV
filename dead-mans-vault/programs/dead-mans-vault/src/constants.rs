use anchor_lang::prelude::Pubkey;

/// Vault creation fee (0.01 SOL), paid by the owner to `FEE_WALLET` on
/// `initialize_vault`. Enforced on-chain — a vault cannot be created without it.
pub const VAULT_CREATION_FEE_LAMPORTS: u64 = 10_000_000;

/// Recipient of the vault creation fee.
pub const FEE_WALLET: Pubkey =
    anchor_lang::pubkey!("98x9Rn63Ne8xbL3w522zgbuYg9bdHn7cRqJQVCUZUFsp");

/// Minimum heartbeat interval: 10 seconds (devnet demo-friendly).
/// MAINNET: Restore to 86_400 (1 day) before mainnet deployment.
pub const MIN_HEARTBEAT_INTERVAL: i64 = 10;

/// Minimum grace period: 30 seconds (devnet demo-friendly).
/// MAINNET: Restore to 604_800 (7 days) before mainnet deployment.
pub const MIN_GRACE_PERIOD: i64 = 30;

/// Maximum beneficiaries per vault. Tracked with a u32 paid-mask.
pub const MAX_BENEFICIARIES: usize = 20;

/// Maximum specific-bequest assignments per vault. Tracked with a u64 paid-mask.
pub const MAX_ASSIGNMENTS: usize = 64;

// Mask width invariants — the paid-mask types depend on these bounds.
const _: () = assert!(MAX_BENEFICIARIES <= 32);
const _: () = assert!(MAX_ASSIGNMENTS <= 64);

/// Full beneficiary mask for `n` beneficiaries (n <= 32). Uses a u64 widen so
/// `n == 32` does not hit the `1u32 << 32` undefined-shift case.
#[inline]
pub fn full_mask_u32(n: usize) -> u32 {
    ((1u64 << n) - 1) as u32
}

/// Full assignment mask for `n` assignments (n <= 64). Uses a u128 widen so
/// `n == 64` does not hit the `1u64 << 64` undefined-shift case.
#[inline]
pub fn full_mask_u64(n: usize) -> u64 {
    ((1u128 << n) - 1) as u64
}
