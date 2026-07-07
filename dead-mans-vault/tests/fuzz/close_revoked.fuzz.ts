// D3 — close_revoked_vault coverage. This is the backward-compat cleanup for "zombie"
// vaults (revoked under an older program that didn't close the PDAs). Two cases:
//   (a) GUARD — refuses to close a still-ACTIVE vault (VaultStillActive / 6017), so it
//       can never be abused to close a live vault.
//   (b) HAPPY PATH — closes a genuine zombie (!active && !executed), returning rent.
//       Current instructions can't PRODUCE a zombie (revoke_vault closes the PDA;
//       finalize sets executed), so the zombie is crafted with LiteSVM setAccount:
//       init a real vault, flip its `active` flag byte to 0, write it back. The
//       VaultConfig flag layout (post-beneficiaries-Vec) is 92 + n*34: executed@base,
//       active@base+1 (matches sequence.fuzz.ts's vaultFlagBase). Deterministic
//       single-scenario tests; one file/process (LiteSVM native memory, see setup.ts).

import { expect } from "chai";
import {
  program,
  send,
  bal,
  isClosed,
  expectBadTx,
} from "./harness";
import { makeVault } from "./setup";

const vaultFlagBase = (n: number) => 92 + n * 34;

describe("fuzz — D3 close_revoked_vault (LiteSVM)", () => {
  it("D3a guard: close_revoked_vault on an ACTIVE vault reverts VaultStillActive (6017)", async function () {
    this.timeout(120_000);
    try {
      const n = 3;
      const shares = [4000, 3000, 3000];
      const { svm, owner, pdas } = await makeVault(n, shares, 0n, 0n);
      // The vault is active + not executed → close_revoked_vault must refuse it.
      await expectBadTx(
        svm,
        program.methods
          .closeRevokedVault()
          .accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat })
          .transaction(),
        owner,
        [],
        { code: 6017, name: "VaultStillActive" }
      );
    } finally {
      (global as any).gc?.();
    }
  });

  it("D3b happy path: a crafted !active && !executed zombie closes, rent → owner", async function () {
    this.timeout(120_000);
    try {
      const n = 3;
      const shares = [4000, 3000, 3000];
      const { svm, owner, pdas } = await makeVault(n, shares, 0n, 0n);

      // Craft the zombie: read the live VaultConfig, flip `active` (base+1) to 0, write
      // it back via the native setAccount (no on-chain path can produce this state).
      const base = vaultFlagBase(n);
      const innerPk = pdas.vault.toBytes();
      const acc = (svm as any).inner.getAccount(innerPk);
      const data = Uint8Array.from(acc.data());
      // Sanity-check the layout before mutating so a wrong offset can't false-pass.
      expect(data[base], "executed flag @base == false").to.equal(0);
      expect(data[base + 1], "active flag @base+1 == true").to.equal(1);
      data[base + 1] = 0; // active → false ⇒ zombie
      const zombie = new acc.constructor(acc.lamports(), data, acc.owner(), acc.executable(), acc.rentEpoch());
      (svm as any).inner.setAccount(innerPk, zombie);

      const balBefore = bal(svm, owner.publicKey);
      send(
        svm,
        await program.methods
          .closeRevokedVault()
          .accountsPartial({ owner: owner.publicKey, vaultConfig: pdas.vault, heartbeatRecord: pdas.heartbeat })
          .transaction(),
        owner
      );

      expect(isClosed(svm, pdas.vault), "VaultConfig closed").to.equal(true);
      expect(isClosed(svm, pdas.heartbeat), "HeartbeatRecord closed").to.equal(true);
      // Both PDAs' rent (≫ the ~5k tx fee) returned to owner ⇒ net balance increased.
      expect(bal(svm, owner.publicKey) > balBefore, "rent returned to owner").to.equal(true);
    } finally {
      (global as any).gc?.();
    }
  });
});
