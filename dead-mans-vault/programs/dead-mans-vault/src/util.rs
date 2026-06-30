use anchor_lang::prelude::*;
use crate::errors::VaultError;
use crate::state::{AssetPlan, Beneficiary};

/// Absolute deadline at which execution becomes possible:
/// `last_heartbeat + heartbeat_interval + grace_period` (checked i64 chain).
pub fn deadline(last_heartbeat: i64, heartbeat_interval: i64, grace_period: i64) -> Result<i64> {
    last_heartbeat
        .checked_add(heartbeat_interval)
        .and_then(|v| v.checked_add(grace_period))
        .ok_or(error!(VaultError::GraceNotElapsed))
}

/// Grace is considered elapsed once the deadline is *reached* (`>=`).
pub fn grace_elapsed(now: i64, deadline_ts: i64) -> bool {
    now >= deadline_ts
}

/// Mask of all lower-index assignments that share `mint` with assignment `j`.
/// First-of-mint → 0 (guard always passes); only same-mint lower bits gate.
pub fn lower_index_same_mint_mask(plan: &AssetPlan, mint: Pubkey, j: usize) -> u64 {
    let mut m = 0u64;
    for k in 0..j {
        if plan.assignments[k].mint == mint {
            m |= 1u64 << k;
        }
    }
    m
}

/// Index of the largest-share beneficiary (ties resolve to the lowest index).
/// Used to pin the dust-sweep destination on close.
pub fn largest_share_index(beneficiaries: &[Beneficiary]) -> usize {
    let mut best = 0usize;
    let mut best_bps = 0u16;
    for (i, b) in beneficiaries.iter().enumerate() {
        if b.share_bps > best_bps {
            best_bps = b.share_bps;
            best = i;
        }
    }
    best
}
