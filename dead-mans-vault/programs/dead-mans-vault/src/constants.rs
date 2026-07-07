use anchor_lang::prelude::Pubkey;

/// Vault creation fee (0.01 SOL), paid by the owner to `FEE_WALLET` on
/// `initialize_vault`. Enforced on-chain — a vault cannot be created without it.
pub const VAULT_CREATION_FEE_LAMPORTS: u64 = 10_000_000;

/// Recipient of the vault creation fee.
pub const FEE_WALLET: Pubkey =
    anchor_lang::pubkey!("98x9Rn63Ne8xbL3w522zgbuYg9bdHn7cRqJQVCUZUFsp");

/// Default keeper bounty (0.005 SOL) — reserved in the vault at init and paid to
/// whoever cranks finalize_execution. Client default; the owner may pass 0 to opt
/// out. Carved out of the SOL snapshot so it never touches beneficiary payouts.
pub const KEEPER_BOUNTY_LAMPORTS: u64 = 5_000_000;

/// Upper bound on the keeper bounty an owner may set at init (0.1 SOL). Real crank
/// costs are well under 0.01 SOL, so this is generous while preventing a
/// pathological bounty from consuming the estate (the bounty is carved out of the
/// SOL snapshot before beneficiary payouts, so an unbounded value could zero them).
pub const MAX_KEEPER_BOUNTY_LAMPORTS: u64 = 100_000_000;

// Minimum heartbeat interval / grace period.
//
// The safe production values (1 day / 7 days) are the DEFAULT so a plain
// `anchor build` / mainnet deploy is fail-safe. The short demo floors are gated
// behind the opt-in `devnet` Cargo feature, used only for tests and devnet builds
// (execution tests need ~40s grace waits). Build tests/devnet with:
//     anchor build -- --features devnet
#[cfg(feature = "devnet")]
pub const MIN_HEARTBEAT_INTERVAL: i64 = 10;
#[cfg(not(feature = "devnet"))]
pub const MIN_HEARTBEAT_INTERVAL: i64 = 86_400; // 1 day

#[cfg(feature = "devnet")]
pub const MIN_GRACE_PERIOD: i64 = 30;
#[cfg(not(feature = "devnet"))]
pub const MIN_GRACE_PERIOD: i64 = 604_800; // 7 days

// Owner-exclusive window after execution begins, before the permissionless
// `close_executed_vault` may claim the core-PDA rents. A living owner can close
// (and reclaim rent) any time via `close_executed_vault_by_owner`; after this
// window, anyone may close and take the otherwise-stranded rents as a keeper
// reward (a dead owner's rent would strand forever). 24 h in production; 60 s
// under the `devnet` feature so tests/demos aren't stuck waiting.
#[cfg(feature = "devnet")]
pub const EXECUTED_CLOSE_DELAY: i64 = 60;
#[cfg(not(feature = "devnet"))]
pub const EXECUTED_CLOSE_DELAY: i64 = 86_400; // 24 hours

// Upper safety bounds on the owner-set heartbeat interval / grace period. These are
// PLAIN (not `devnet`-gated) — they cap both build profiles. Without them, a value near
// i64::MAX makes `deadline()`'s checked_add overflow, which errors out of EVERY freeze
// check + begin_execution and bricks the vault (funds locked, no heartbeat/withdraw/
// execute). Sized far above any value the app can send (app max = 30-day interval /
// 17-day grace): 1 year / 2 years, so no legitimate config is ever rejected, while
// interval+grace (≤ ~9.5e7) can never overflow i64 (~9.2e18) for any real timestamp.
pub const MAX_HEARTBEAT_INTERVAL: i64 = 31_536_000; // 365 days
pub const MAX_GRACE_PERIOD: i64 = 63_072_000; // 730 days

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

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards against shipping the demo floors to production: a default build
    /// MUST enforce 1 day / 7 days; only the opt-in `devnet` feature lowers them.
    /// CI runs `cargo test` (asserts prod) and `cargo test --features devnet`.
    #[test]
    fn min_durations_match_build_profile() {
        #[cfg(feature = "devnet")]
        {
            assert_eq!(MIN_HEARTBEAT_INTERVAL, 10);
            assert_eq!(MIN_GRACE_PERIOD, 30);
            assert_eq!(EXECUTED_CLOSE_DELAY, 60);
        }
        #[cfg(not(feature = "devnet"))]
        {
            assert_eq!(MIN_HEARTBEAT_INTERVAL, 86_400);
            assert_eq!(MIN_GRACE_PERIOD, 604_800);
            assert_eq!(EXECUTED_CLOSE_DELAY, 86_400);
        }
    }
}
