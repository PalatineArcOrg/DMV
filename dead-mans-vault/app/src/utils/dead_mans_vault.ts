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
      "name": "beginExecution",
      "discriminator": [
        148,
        246,
        18,
        188,
        252,
        93,
        187,
        14
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultConfig",
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
          "name": "assetPlan",
          "docs": [
            "Required iff `vault_config.has_asset_plan` — read to carve specific-SOL",
            "bequests out of the pro-rata residual (pinned by seeds; omitted otherwise)."
          ],
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116,
                  95,
                  112,
                  108,
                  97,
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
      "args": []
    },
    {
      "name": "beginTokenDist",
      "discriminator": [
        167,
        52,
        216,
        51,
        38,
        109,
        214,
        111
      ],
      "accounts": [
        {
          "name": "payer",
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
                "path": "vault_config.owner",
                "account": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "executionLog",
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
          "name": "mint"
        },
        {
          "name": "vaultAta",
          "docs": [
            "The vault's canonical associated token account for `mint`. May not exist."
          ]
        },
        {
          "name": "assetPlan",
          "docs": [
            "Required iff `vault_config.has_asset_plan` (P1)."
          ],
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116,
                  95,
                  112,
                  108,
                  97,
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
          "name": "tokenDist",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  100,
                  105,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closeExecutedVaultByOwner",
      "discriminator": [
        150,
        87,
        101,
        17,
        65,
        196,
        81,
        153
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
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
          "name": "assetPlan",
          "docs": [
            "Present iff `vault_config.has_asset_plan`. Closed manually (rent → owner)",
            "so the PDA slot frees for a future re-init on the same wallet."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116,
                  95,
                  112,
                  108,
                  97,
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
          "name": "largestBenef",
          "docs": [
            "Required only when SOL dust remains to be swept."
          ],
          "writable": true,
          "optional": true
        }
      ],
      "args": []
    },
    {
      "name": "closeRevokedVault",
      "discriminator": [
        133,
        1,
        201,
        37,
        182,
        253,
        224,
        48
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
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
        }
      ],
      "args": []
    },
    {
      "name": "closeTokenDist",
      "discriminator": [
        195,
        78,
        81,
        239,
        193,
        38,
        13,
        139
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "owner",
          "docs": [
            "Owner receives the ATA rent on close."
          ],
          "writable": true
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
                "path": "vault_config.owner",
                "account": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "vaultAta",
          "writable": true
        },
        {
          "name": "tokenDist",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  100,
                  105,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "largestBenefAta",
          "docs": [
            "Required only when there is dust to sweep (vault_ata.amount > 0)."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "executeSolShares",
      "discriminator": [
        20,
        134,
        130,
        46,
        12,
        18,
        250,
        239
      ],
      "accounts": [
        {
          "name": "payer",
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
                "path": "vault_config.owner",
                "account": "vaultConfig"
              }
            ]
          }
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
        }
      ],
      "args": [
        {
          "name": "indices",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "executeSpecificAsset",
      "discriminator": [
        233,
        66,
        213,
        215,
        245,
        87,
        36,
        236
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultConfig",
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
          "name": "executionLog",
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
          "name": "assetPlan",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116,
                  95,
                  112,
                  108,
                  97,
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
          "name": "mint"
        },
        {
          "name": "tokenDist",
          "docs": [
            "Must already exist — its presence gates execution order (§2)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  100,
                  105,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "vaultAta",
          "writable": true
        },
        {
          "name": "beneficiaryAta",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "assignmentIndex",
          "type": "u8"
        }
      ]
    },
    {
      "name": "executeSpecificSol",
      "discriminator": [
        141,
        193,
        131,
        18,
        244,
        218,
        140,
        25
      ],
      "accounts": [
        {
          "name": "payer",
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
                "path": "vault_config.owner",
                "account": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "executionLog",
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
          "name": "assetPlan",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116,
                  95,
                  112,
                  108,
                  97,
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
          "name": "beneficiary",
          "docs": [
            "`beneficiaries[assignment.beneficiary_index].wallet`."
          ],
          "writable": true
        }
      ],
      "args": [
        {
          "name": "assignmentIndex",
          "type": "u8"
        }
      ]
    },
    {
      "name": "executeTokenShares",
      "discriminator": [
        106,
        134,
        145,
        19,
        240,
        253,
        121,
        235
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultConfig",
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
          "name": "tokenDist",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  100,
                  105,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "vaultAta",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "indices",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "finalizeExecution",
      "discriminator": [
        204,
        146,
        126,
        8,
        192,
        189,
        127,
        166
      ],
      "accounts": [
        {
          "name": "payer",
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
                "path": "vault_config.owner",
                "account": "vaultConfig"
              }
            ]
          }
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
          "name": "assetPlan",
          "docs": [
            "Required iff `vault_config.has_asset_plan` (P11 — omitted otherwise)."
          ],
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116,
                  95,
                  112,
                  108,
                  97,
                  110
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
      "args": []
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
          "name": "feeRecipient",
          "docs": [
            "Recipient of the on-chain vault-creation fee. Pinned to the hardcoded",
            "FEE_WALLET, so a vault cannot be created without paying the fee."
          ],
          "writable": true,
          "address": "98x9Rn63Ne8xbL3w522zgbuYg9bdHn7cRqJQVCUZUFsp"
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
            "Only the owner can revoke; receives rent refund from closed accounts"
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
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
          "name": "assetPlan",
          "docs": [
            "Present iff `vault_config.has_asset_plan`. Closed manually so its PDA slot",
            "frees for re-initialization on the same wallet."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116,
                  95,
                  112,
                  108,
                  97,
                  110
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
          "name": "newAgentPubkey",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setAssetPlan",
      "discriminator": [
        154,
        174,
        170,
        203,
        17,
        18,
        71,
        138
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
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
          "name": "assetPlan",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116,
                  95,
                  112,
                  108,
                  97,
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
          "name": "assignments",
          "type": {
            "vec": {
              "defined": {
                "name": "assetAssignment"
              }
            }
          }
        }
      ]
    },
    {
      "name": "updateAssetPlan",
      "discriminator": [
        219,
        132,
        15,
        22,
        230,
        103,
        217,
        222
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
          "name": "assetPlan",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116,
                  95,
                  112,
                  108,
                  97,
                  110
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
          "name": "assignments",
          "type": {
            "vec": {
              "defined": {
                "name": "assetAssignment"
              }
            }
          }
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
          "name": "params",
          "type": {
            "defined": {
              "name": "updateVaultParams"
            }
          }
        }
      ]
    },
    {
      "name": "withdrawFromVault",
      "discriminator": [
        180,
        34,
        37,
        46,
        156,
        0,
        211,
        238
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "Owner signs — only the vault owner can withdraw deposited tokens"
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
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
            "Vault PDA's token account to withdraw FROM — must be owned by the vault PDA"
          ],
          "writable": true
        },
        {
          "name": "destinationTokenAccount",
          "docs": [
            "Owner's token account to withdraw TO — must match the same mint"
          ],
          "writable": true
        },
        {
          "name": "vaultAuthority",
          "docs": [
            "Vault PDA as signing authority for the token transfer.",
            "constraint. No data deserialization needed — only PDA signature."
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
                "path": "owner"
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
        }
      ]
    },
    {
      "name": "withdrawSolFromVault",
      "discriminator": [
        125,
        47,
        97,
        57,
        61,
        245,
        60,
        158
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "Owner signs — only the vault owner can withdraw deposited SOL"
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
          "docs": [
            "The vault PDA holds both config data AND deposited SOL.",
            "Lamports above rent-exemption are available for withdrawal."
          ],
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
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "assetPlan",
      "discriminator": [
        178,
        115,
        162,
        79,
        78,
        70,
        195,
        45
      ]
    },
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
      "name": "tokenDist",
      "discriminator": [
        250,
        253,
        174,
        111,
        42,
        82,
        178,
        42
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
    },
    {
      "code": 6016,
      "name": "insufficientVaultBalance",
      "msg": "Insufficient SOL in vault for distribution"
    },
    {
      "code": 6017,
      "name": "vaultStillActive",
      "msg": "Vault is still active — revoke it first"
    },
    {
      "code": 6018,
      "name": "vaultNotExecuted",
      "msg": "Vault has not been executed yet"
    },
    {
      "code": 6019,
      "name": "graceNotElapsed",
      "msg": "Grace period has not elapsed yet"
    },
    {
      "code": 6020,
      "name": "executionFinalized",
      "msg": "Execution has already been finalized"
    },
    {
      "code": 6021,
      "name": "assetPlanRequired",
      "msg": "This vault requires an AssetPlan account"
    },
    {
      "code": 6022,
      "name": "assetPlanImmutable",
      "msg": "AssetPlan cannot be changed after grace has elapsed or execution has begun"
    },
    {
      "code": 6023,
      "name": "beneficiaryMismatch",
      "msg": "Provided account does not match the beneficiary at this index"
    },
    {
      "code": 6024,
      "name": "mintMismatch",
      "msg": "Provided mint does not match the assignment or distribution"
    },
    {
      "code": 6025,
      "name": "tokenAccountMismatch",
      "msg": "Token account owner or mint does not match the expected value"
    },
    {
      "code": 6026,
      "name": "specificOutOfOrder",
      "msg": "Specific bequests for a mint must be paid in ascending index order"
    },
    {
      "code": 6027,
      "name": "maskAlreadySet",
      "msg": "This payout has already been recorded"
    },
    {
      "code": 6028,
      "name": "notAllSharesPaid",
      "msg": "Not all beneficiary shares have been paid yet"
    },
    {
      "code": 6029,
      "name": "tokensRemain",
      "msg": "Tokens remain in the vault — close all token distributions first"
    },
    {
      "code": 6030,
      "name": "tooManyAssignments",
      "msg": "Too many specific-bequest assignments (max 64)"
    },
    {
      "code": 6031,
      "name": "duplicateNftAssignment",
      "msg": "An NFT mint can have at most one assignment"
    },
    {
      "code": 6032,
      "name": "invalidBeneficiaryIndex",
      "msg": "Beneficiary index is out of range"
    },
    {
      "code": 6033,
      "name": "accountCountMismatch",
      "msg": "Account count does not match the provided indices"
    },
    {
      "code": 6034,
      "name": "invalidVaultAta",
      "msg": "Vault PDA address does not match the derived associated token account"
    },
    {
      "code": 6035,
      "name": "vaultFrozen",
      "msg": "Grace period has elapsed — the vault is frozen pending execution"
    },
    {
      "code": 6036,
      "name": "beneficiariesLockedByPlan",
      "msg": "Beneficiaries cannot be changed while an AssetPlan exists — clear the plan first"
    },
    {
      "code": 6037,
      "name": "invalidFeeRecipient",
      "msg": "Fee recipient account does not match the required fee wallet"
    },
    {
      "code": 6038,
      "name": "invalidSolBequest",
      "msg": "A SOL bequest must have is_nft = false and a non-zero amount"
    }
  ],
  "types": [
    {
      "name": "assetAssignment",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "docs": [
              "Mint of the bequeathed asset (SPL/NFT only in v1)"
            ],
            "type": "pubkey"
          },
          {
            "name": "amount",
            "docs": [
              "Exact base units to transfer; 1 for an NFT"
            ],
            "type": "u64"
          },
          {
            "name": "beneficiaryIndex",
            "docs": [
              "Index into VaultConfig.beneficiaries"
            ],
            "type": "u8"
          },
          {
            "name": "isNft",
            "docs": [
              "Whether this assignment is a whole NFT (decimals 0, supply 1).",
              "NFT shape is validated client-side (B4) — this flag enforces the",
              "\"at most one assignment per NFT mint\" rule on-chain."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "assetPlan",
      "docs": [
        "One per vault, fixed-size. Owner-defined specific bequests (SPL tokens + NFTs",
        "only in v1). Created by `set_asset_plan` (strict `init` at full size), edited",
        "by `update_asset_plan` (owner overwrite). Lives on the heap, not the stack."
      ],
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
            "name": "assignments",
            "docs": [
              "Specific-bequest assignments (fixed cap MAX_ASSIGNMENTS)"
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "assetAssignment"
                }
              }
            }
          },
          {
            "name": "paidMask",
            "docs": [
              "Bit j set when assignment j has been executed"
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
          }
        ]
      }
    },
    {
      "name": "executionLog",
      "docs": [
        "Created by `begin_execution`. Its mere existence == \"execution has begun\"",
        "(and proves grace was elapsed at that point — downstream permissionless",
        "instructions gate on this account existing rather than re-checking grace)."
      ],
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
            "name": "solSnapshot",
            "docs": [
              "Lamports residual for the pro-rata split = (vault balance − rent) − Σ",
              "specific-SOL bequests, frozen at begin_execution. Specific-SOL amounts are",
              "paid separately by execute_specific_sol (carved out here, like token specifics)."
            ],
            "type": "u64"
          },
          {
            "name": "solPaidMask",
            "docs": [
              "Bit i set when beneficiary i has been paid their SOL share."
            ],
            "type": "u32"
          },
          {
            "name": "startedAt",
            "docs": [
              "Timestamp execution began"
            ],
            "type": "i64"
          },
          {
            "name": "completed",
            "docs": [
              "Whether finalize_execution has run (sol + asset masks full)"
            ],
            "type": "bool"
          },
          {
            "name": "transferCount",
            "docs": [
              "Number of SOL transfers executed (incremented only on 0->1 mask transition)"
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
      "name": "tokenDist",
      "docs": [
        "One per (vault, mint). Created by `begin_token_dist`, which freezes the",
        "pro-rata residual (ATA balance minus the sum of specific bequests for this",
        "mint) write-once via strict `init`. Closed by `close_token_dist`."
      ],
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
            "name": "mint",
            "docs": [
              "The mint this distribution tracks"
            ],
            "type": "pubkey"
          },
          {
            "name": "snapshot",
            "docs": [
              "Residual = ata_balance - Σspecific(mint), frozen at begin_token_dist"
            ],
            "type": "u64"
          },
          {
            "name": "paidMask",
            "docs": [
              "Bit i set when beneficiary i has been paid this token's residual share"
            ],
            "type": "u32"
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
              "Agent's TEE-generated execution pubkey (heartbeats only)"
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
              "Registered beneficiaries (on-chain whitelist). Index is authoritative —",
              "AssetPlan assignments and paid-masks reference beneficiaries by index."
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
          },
          {
            "name": "hasAssetPlan",
            "docs": [
              "Whether a canonical AssetPlan PDA exists for this vault. Set true by",
              "`set_asset_plan`; gates whether execution instructions require the plan."
            ],
            "type": "bool"
          },
          {
            "name": "openTokenDists",
            "docs": [
              "Number of TokenDist PDAs currently open (incremented by begin_token_dist,",
              "decremented by close_token_dist). The owner-close requires this to be 0 so",
              "a started token distribution can never be orphaned by a premature close."
            ],
            "type": "u16"
          }
        ]
      }
    }
  ]
};
