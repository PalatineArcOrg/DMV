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
}
