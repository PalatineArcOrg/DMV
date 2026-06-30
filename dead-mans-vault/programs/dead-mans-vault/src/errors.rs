use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Heartbeat interval must be at least 86400 seconds (1 day)")]
    HeartbeatIntervalTooShort,

    #[msg("Grace period must be at least 604800 seconds (7 days)")]
    GracePeriodTooShort,

    #[msg("Invalid beneficiary count (must be 1-20)")]
    InvalidBeneficiaryCount,

    #[msg("Beneficiary shares must sum to 10000 basis points (100%)")]
    InvalidShareAllocation,

    #[msg("Owner cannot be a beneficiary")]
    OwnerCannotBeBeneficiary,

    #[msg("Signer is not the registered agent")]
    UnauthorizedAgent,

    #[msg("Signer is not the vault owner")]
    UnauthorizedOwner,

    #[msg("Vault is not active")]
    VaultInactive,

    #[msg("Vault has already been executed")]
    VaultAlreadyExecuted,

    #[msg("Grace period has not fully elapsed")]
    GracePeriodNotElapsed,

    #[msg("Destination wallet is not a registered beneficiary")]
    UnregisteredBeneficiary,

    #[msg("Heartbeat record does not match vault")]
    HeartbeatVaultMismatch,

    #[msg("New agent pubkey cannot be the zero address")]
    InvalidAgentPubkey,

    #[msg("Agent pubkey cannot be the same as the owner")]
    AgentCannotBeOwner,

    #[msg("New agent pubkey is the same as the current agent")]
    AgentKeyUnchanged,

    #[msg("Vault is immutable and cannot be revoked or updated")]
    VaultImmutable,

    #[msg("Insufficient SOL in vault for distribution")]
    InsufficientVaultBalance,

    #[msg("Vault is still active — revoke it first")]
    VaultStillActive,

    #[msg("Vault has not been executed yet")]
    VaultNotExecuted,

    // ---- Permissionless autonomous execution (v2) ----

    #[msg("Grace period has not elapsed yet")]
    GraceNotElapsed,

    #[msg("Execution has already been finalized")]
    ExecutionFinalized,

    #[msg("This vault requires an AssetPlan account")]
    AssetPlanRequired,

    #[msg("AssetPlan cannot be changed after grace has elapsed or execution has begun")]
    AssetPlanImmutable,

    #[msg("Provided account does not match the beneficiary at this index")]
    BeneficiaryMismatch,

    #[msg("Provided mint does not match the assignment or distribution")]
    MintMismatch,

    #[msg("Token account owner or mint does not match the expected value")]
    TokenAccountMismatch,

    #[msg("Specific bequests for a mint must be paid in ascending index order")]
    SpecificOutOfOrder,

    #[msg("This payout has already been recorded")]
    MaskAlreadySet,

    #[msg("Not all beneficiary shares have been paid yet")]
    NotAllSharesPaid,

    #[msg("Tokens remain in the vault — close all token distributions first")]
    TokensRemain,

    #[msg("Too many specific-bequest assignments (max 64)")]
    TooManyAssignments,

    #[msg("An NFT mint can have at most one assignment")]
    DuplicateNftAssignment,

    #[msg("Beneficiary index is out of range")]
    InvalidBeneficiaryIndex,

    #[msg("Account count does not match the provided indices")]
    AccountCountMismatch,

    #[msg("Vault PDA address does not match the derived associated token account")]
    InvalidVaultAta,

    #[msg("Grace period has elapsed — the vault is frozen pending execution")]
    VaultFrozen,

    #[msg("Beneficiaries cannot be changed while an AssetPlan exists — clear the plan first")]
    BeneficiariesLockedByPlan,
}
