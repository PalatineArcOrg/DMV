/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/dead_mans_vault.json`.
 */
export type DeadMansVault = {
  "address": "GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb",
  "metadata": {
    "name": "deadMansVault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "executeDistribution",
      "discriminator": [
        163,
        217,
        35,
        57,
        238,
        179,
        71,
        204
      ],
      "accounts": [
        {
          "name": "agent",
          "docs": [
            "Agent signs — must match vault_config.agent_pubkey"
          ],
          "signer": true
        },
        {
          "name": "vaultConfig",
          "writable": true
        },
        {
          "name": "heartbeatRecord",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  101,
                  97,
                  114,
                  116,
                  98,
                  101,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "sourceTokenAccount",
          "docs": [
            "Owner's token account to transfer FROM"
          ],
          "writable": true
        },
        {
          "name": "destinationTokenAccount",
          "docs": [
            "Beneficiary's token account to transfer TO"
          ],
          "writable": true
        },
        {
          "name": "vaultAuthority",
          "docs": [
            "Vault PDA as delegate authority"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault_config.owner",
                "account": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "attestationHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "initializeVault",
      "discriminator": [
        48,
        191,
        163,
        44,
        71,
        129,
        63,
        164
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "heartbeatRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  101,
                  97,
                  114,
                  116,
                  98,
                  101,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "initializeVaultParams"
            }
          }
        }
      ]
    },
    {
      "name": "recordExecution",
      "discriminator": [
        231,
        245,
        144,
        129,
        178,
        195,
        89,
        160
      ],
      "accounts": [
        {
          "name": "agent",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultConfig",
          "writable": true
        },
        {
          "name": "executionLog",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  101,
                  99,
                  117,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "recordExecutionParams"
            }
          }
        }
      ]
    },
    {
      "name": "recordHeartbeat",
      "discriminator": [
        109,
        43,
        126,
        223,
        32,
        70,
        78,
        82
      ],
      "accounts": [
        {
          "name": "agent",
          "docs": [
            "The agent's TEE-generated keypair signs this"
          ],
          "signer": true
        },
        {
          "name": "vaultConfig"
        },
        {
          "name": "heartbeatRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  101,
                  97,
                  114,
                  116,
                  98,
                  101,
                  97,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "method",
          "type": {
            "defined": {
              "name": "heartbeatMethod"
            }
          }
        }
      ]
    },
    {
      "name": "revokeVault",
      "discriminator": [
        199,
        172,
        226,
        172,
        196,
        244,
        179,
        103
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "Only the owner can revoke"
          ],
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "rotateAgent",
      "discriminator": [
        182,
        91,
        147,
        107,
        155,
        47,
        150,
        176
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "Only the owner can rotate the agent key.",
            "The OLD agent must NOT be able to rotate itself."
          ],
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
          "writable": true
        },
        {
          "name": "heartbeatRecord",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "newAgentPubkey",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "updateVault",
      "discriminator": [
        67,
        229,
        185,
        188,
        226,
        11,
        210,
        60
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "updateVaultParams"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "executionLog",
      "discriminator": [
        115,
        151,
        52,
        213,
        99,
        171,
        200,
        240
      ]
    },
    {
      "name": "heartbeatRecord",
      "discriminator": [
        29,
        4,
        80,
        38,
        159,
        52,
        106,
        203
      ]
    },
    {
      "name": "vaultConfig",
      "discriminator": [
        99,
        86,
        43,
        216,
        184,
        102,
        119,
        77
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "heartbeatIntervalTooShort",
      "msg": "Heartbeat interval must be at least 86400 seconds (1 day)"
    },
    {
      "code": 6001,
      "name": "gracePeriodTooShort",
      "msg": "Grace period must be at least 604800 seconds (7 days)"
    },
    {
      "code": 6002,
      "name": "invalidBeneficiaryCount",
      "msg": "Invalid beneficiary count (must be 1-20)"
    },
    {
      "code": 6003,
      "name": "invalidShareAllocation",
      "msg": "Beneficiary shares must sum to 10000 basis points (100%)"
    },
    {
      "code": 6004,
      "name": "ownerCannotBeBeneficiary",
      "msg": "Owner cannot be a beneficiary"
    },
    {
      "code": 6005,
      "name": "unauthorizedAgent",
      "msg": "Signer is not the registered agent"
    },
    {
      "code": 6006,
      "name": "unauthorizedOwner",
      "msg": "Signer is not the vault owner"
    },
    {
      "code": 6007,
      "name": "vaultInactive",
      "msg": "Vault is not active"
    },
    {
      "code": 6008,
      "name": "vaultAlreadyExecuted",
      "msg": "Vault has already been executed"
    },
    {
      "code": 6009,
      "name": "gracePeriodNotElapsed",
      "msg": "Grace period has not fully elapsed"
    },
    {
      "code": 6010,
      "name": "unregisteredBeneficiary",
      "msg": "Destination wallet is not a registered beneficiary"
    },
    {
      "code": 6011,
      "name": "heartbeatVaultMismatch",
      "msg": "Heartbeat record does not match vault"
    },
    {
      "code": 6012,
      "name": "invalidAgentPubkey",
      "msg": "New agent pubkey cannot be the zero address"
    },
    {
      "code": 6013,
      "name": "agentCannotBeOwner",
      "msg": "Agent pubkey cannot be the same as the owner"
    },
    {
      "code": 6014,
      "name": "agentKeyUnchanged",
      "msg": "New agent pubkey is the same as the current agent"
    },
    {
      "code": 6015,
      "name": "vaultImmutable",
      "msg": "Vault is immutable and cannot be revoked or updated"
    }
  ],
  "types": [
    {
      "name": "beneficiary",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "docs": [
              "Wallet address to receive assets"
            ],
            "type": "pubkey"
          },
          {
            "name": "shareBps",
            "docs": [
              "Percentage share (basis points, 10000 = 100%)"
            ],
            "type": "u16"
          },
          {
            "name": "hasSpecificAssets",
            "docs": [
              "Whether this beneficiary has specific asset assignments"
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "executionLog",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "Associated vault config"
            ],
            "type": "pubkey"
          },
          {
            "name": "executedAt",
            "docs": [
              "Timestamp of execution"
            ],
            "type": "i64"
          },
          {
            "name": "transferCount",
            "docs": [
              "Number of transfers executed"
            ],
            "type": "u32"
          },
          {
            "name": "totalSolDistributed",
            "docs": [
              "Total SOL distributed (in lamports)"
            ],
            "type": "u64"
          },
          {
            "name": "tokenTypesDistributed",
            "docs": [
              "Total SPL token types distributed"
            ],
            "type": "u32"
          },
          {
            "name": "attestationHash",
            "docs": [
              "TEE attestation data hash (32 bytes)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "completed",
            "docs": [
              "Whether execution completed fully"
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "heartbeatMethod",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "activeTap"
          },
          {
            "name": "biometricConfirm"
          },
          {
            "name": "onChainActivity"
          },
          {
            "name": "pinChallenge"
          },
          {
            "name": "hardwareSwitch"
          }
        ]
      }
    },
    {
      "name": "heartbeatRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "Associated vault config"
            ],
            "type": "pubkey"
          },
          {
            "name": "lastHeartbeat",
            "docs": [
              "Timestamp of last confirmed heartbeat (Unix epoch)"
            ],
            "type": "i64"
          },
          {
            "name": "lastMethod",
            "docs": [
              "Method used for last heartbeat"
            ],
            "type": {
              "defined": {
                "name": "heartbeatMethod"
              }
            }
          },
          {
            "name": "totalHeartbeats",
            "docs": [
              "Total heartbeats recorded"
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed"
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "initializeVaultParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agentPubkey",
            "type": "pubkey"
          },
          {
            "name": "heartbeatInterval",
            "type": "i64"
          },
          {
            "name": "gracePeriod",
            "type": "i64"
          },
          {
            "name": "beneficiaries",
            "type": {
              "vec": {
                "defined": {
                  "name": "beneficiary"
                }
              }
            }
          },
          {
            "name": "isMutable",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "recordExecutionParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "transferCount",
            "type": "u32"
          },
          {
            "name": "totalSolDistributed",
            "type": "u64"
          },
          {
            "name": "tokenTypesDistributed",
            "type": "u32"
          },
          {
            "name": "attestationHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "completed",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "updateVaultParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "heartbeatInterval",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "gracePeriod",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "beneficiaries",
            "type": {
              "option": {
                "vec": {
                  "defined": {
                    "name": "beneficiary"
                  }
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "vaultConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "Owner wallet pubkey"
            ],
            "type": "pubkey"
          },
          {
            "name": "agentPubkey",
            "docs": [
              "Agent's TEE-generated execution pubkey"
            ],
            "type": "pubkey"
          },
          {
            "name": "heartbeatInterval",
            "docs": [
              "Heartbeat interval in seconds (e.g., 604800 = 7 days)"
            ],
            "type": "i64"
          },
          {
            "name": "gracePeriod",
            "docs": [
              "Total grace period in seconds from first missed heartbeat to execution"
            ],
            "type": "i64"
          },
          {
            "name": "beneficiaries",
            "docs": [
              "Registered beneficiaries (on-chain whitelist)"
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "beneficiary"
                }
              }
            }
          },
          {
            "name": "executed",
            "docs": [
              "Whether the vault has been executed (prevents double-execution)"
            ],
            "type": "bool"
          },
          {
            "name": "active",
            "docs": [
              "Whether the vault is active (owner can deactivate)"
            ],
            "type": "bool"
          },
          {
            "name": "createdAt",
            "docs": [
              "Timestamp when vault was created"
            ],
            "type": "i64"
          },
          {
            "name": "updatedAt",
            "docs": [
              "Timestamp when vault config was last updated"
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA derivation"
            ],
            "type": "u8"
          },
          {
            "name": "isMutable",
            "docs": [
              "Whether the vault can be revoked/updated by the owner (false = immutable)"
            ],
            "type": "bool"
          }
        ]
      }
    }
  ]
};
