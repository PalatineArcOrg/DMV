// D4 — compute-unit budget at MAX beneficiaries. The batched execute_sol_shares /
// execute_token_shares carry ≤8 indices per tx (the tx-size bound the real cranks
// use). Finding D4 asks: at the maximum 20 beneficiaries, does a full batch of 8 stay
// under the CU limits the cranks request? (keeper-bot/src/computeBudget.js CU table:
// execute_sol_shares 250k, execute_token_shares 300k — the token limit carries extra
// headroom for Token-2022 transfer-fee / hook CPIs, which this legacy-SPL measurement
// does NOT exercise; transfer_fee.fuzz.ts (P6) covers the fee mechanics. So the numbers
// here are a floor: real fee/hook mints consume more, which is WHY token=300k>sol=250k.)
//
// This is a single deterministic measurement, not a property — it asserts the REAL
// computeUnitsConsumed (read off LiteSVM's success metadata via sendCU) and logs it so
// the headroom is visible. One file/process (LiteSVM native memory, see setup.ts).

import { expect } from "chai";
import {
  SystemProgram,
  program,
  send,
  sendCU,
  readI64LE,
  OFF_HEARTBEAT_LAST,
  warpClockTo,
  tokenDistPda,
  TOKEN_PROGRAM_ID,
} from "./harness";
import { INTERVAL, GRACE, makeVault, fundVaultToken, makeBeneAtas } from "./setup";

// CU limits the cranks request (must stay in sync with keeper-bot/src/computeBudget.js).
const CU_SOL_SHARES = 250_000;
const CU_TOKEN_SHARES = 300_000;

describe("fuzz — D4 CU budget at max beneficiaries (LiteSVM)", () => {
  it("D4: execute_sol_shares(8) + execute_token_shares(8) at n=20 stay under the crank CU limits", async function () {
    this.timeout(300_000);
    try {
      const n = 20;
      const shares = Array(n).fill(500); // 20 × 500 = 10000 bps
      // 2 SOL deposited so sol_snapshot > 0 (execute_sol_shares does real lamport moves),
      // a full token residual so execute_token_shares does 8 real transfer_checked CPIs.
      const V = await makeVault(n, shares, 0n, 2_000_000_000n);
      const { svm, owner, cranker, benes, pdas } = V;
      const { mint, vaultAta } = fundVaultToken(svm, owner, pdas.vault, 6, 1_000_000_000_000n);

      warpClockTo(
        svm,
        readI64LE(svm, pdas.heartbeat, OFF_HEARTBEAT_LAST) + BigInt(INTERVAL) + BigInt(GRACE) + 5n
      );

      send(
        svm,
        await program.methods
          .beginExecution()
          .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat, executionLog: pdas.execution, assetPlan: null, systemProgram: SystemProgram.programId })
          .transaction(),
        owner,
        [cranker]
      );
      const tokenDist = tokenDistPda(pdas.vault, mint);
      send(
        svm,
        await program.methods
          .beginTokenDist()
          .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution, mint, vaultAta, assetPlan: null, tokenDist, systemProgram: SystemProgram.programId })
          .transaction(),
        owner,
        [cranker]
      );

      const beneAtas = makeBeneAtas(svm, owner, mint, benes.map((b) => b.publicKey));
      const first8 = [0, 1, 2, 3, 4, 5, 6, 7];

      // Measure a FULL batch of 8 for each shares instruction.
      const solCU = sendCU(
        svm,
        await program.methods
          .executeSolShares(Buffer.from(first8))
          .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, executionLog: pdas.execution })
          .remainingAccounts(first8.map((j) => ({ pubkey: benes[j].publicKey, isWritable: true, isSigner: false })))
          .transaction(),
        owner,
        [cranker]
      );
      const tokenCU = sendCU(
        svm,
        await program.methods
          .executeTokenShares(Buffer.from(first8))
          .accountsPartial({ payer: cranker.publicKey, vaultConfig: pdas.vault, tokenDist, mint, vaultAta, tokenProgram: TOKEN_PROGRAM_ID })
          .remainingAccounts(first8.map((j) => ({ pubkey: beneAtas[j], isWritable: true, isSigner: false })))
          .transaction(),
        owner,
        [cranker]
      );

      // eslint-disable-next-line no-console
      console.log(
        `    [D4] n=20 batch-of-8 measured CU — execute_sol_shares: ${solCU}/${CU_SOL_SHARES} ` +
          `(${((Number(solCU) / CU_SOL_SHARES) * 100).toFixed(1)}%), ` +
          `execute_token_shares (legacy SPL): ${tokenCU}/${CU_TOKEN_SHARES} ` +
          `(${((Number(tokenCU) / CU_TOKEN_SHARES) * 100).toFixed(1)}%)`
      );

      expect(Number(solCU), `execute_sol_shares(8) CU ${solCU} < ${CU_SOL_SHARES}`).to.be.lessThan(CU_SOL_SHARES);
      expect(Number(tokenCU), `execute_token_shares(8) CU ${tokenCU} < ${CU_TOKEN_SHARES}`).to.be.lessThan(CU_TOKEN_SHARES);
    } finally {
      (global as any).gc?.();
    }
  });
});
