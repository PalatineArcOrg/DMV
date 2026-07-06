// Shared Phase-2 vault/token setup helpers, imported by specifics.fuzz.ts (P3)
// and theft.fuzz.ts (P4). Not a *.fuzz.ts file, so it isn't run directly — the two
// properties live in SEPARATE files so `yarn test:fuzz` (per-file loop) runs each in
// its own process. That matters: LiteSVM native memory is only reclaimed on process
// exit (no dispose API), so keeping many SVMs in one process pushes V8 over the heap
// limit — process isolation per property bounds the footprint to ~one property's SVMs.

import fc from "fast-check";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  BN,
  program,
  newSvm,
  vaultPdas,
  airdrop,
  send,
  FEE_WALLET,
  assetPlanPda,
  ataFor,
  createMintTx,
  createAtaIx,
  mintToIx,
} from "./harness";

export const INTERVAL = 86_400; // 1 day (production floor)
export const GRACE = 604_800; // 7 days (production floor)
export const MAX_BOUNTY = 100_000_000; // MAX_KEEPER_BOUNTY_LAMPORTS (0.1 SOL)

/** n share_bps parts, each ≥ 0, summing to EXACTLY 10000. */
export function sharesArb(n: number) {
  if (n === 1) return fc.constant<number[]>([10000]);
  return fc
    .array(fc.integer({ min: 0, max: 10000 }), { minLength: n - 1, maxLength: n - 1 })
    .map((cuts) => {
      const sorted = [0, ...cuts.slice().sort((a, b) => a - b), 10000];
      const out: number[] = [];
      for (let i = 1; i < sorted.length; i++) out.push(sorted[i] - sorted[i - 1]);
      return out;
    });
}
export function largestShareIdx(shares: number[]) {
  let m = 0;
  for (let i = 1; i < shares.length; i++) if (shares[i] > shares[m]) m = i;
  return m; // strictly-greater ⇒ ties keep the lowest index (matches on-chain)
}

/** A funded, initialised vault with n beneficiaries + `deposit` lamports of SOL. */
export async function makeVault(n: number, shares: number[], bounty: bigint, deposit: bigint) {
  const svm = newSvm();
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const cranker = Keypair.generate();
  const benes = Array.from({ length: n }, () => Keypair.generate());
  const pdas = vaultPdas(owner.publicKey);
  const assetPlan = assetPlanPda(pdas.vault);

  airdrop(svm, owner.publicKey, deposit + 5_000_000_000n);
  airdrop(svm, cranker.publicKey, 1_000_000_000n);
  airdrop(svm, FEE_WALLET, 1_000_000n);
  for (const b of benes) airdrop(svm, b.publicKey, 10_000_000n);

  const initTx = await program.methods
    .initializeVault({
      agentPubkey: agent.publicKey,
      heartbeatInterval: new BN(INTERVAL),
      gracePeriod: new BN(GRACE),
      beneficiaries: benes.map((b, i) => ({ wallet: b.publicKey, shareBps: shares[i] })),
      isMutable: true,
      keeperBounty: new BN(Number(bounty)),
    })
    .accountsPartial({
      owner: owner.publicKey,
      vaultConfig: pdas.vault,
      heartbeatRecord: pdas.heartbeat,
      feeRecipient: FEE_WALLET,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  send(svm, initTx, owner);
  if (deposit > 0n) {
    send(
      svm,
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: pdas.vault, lamports: Number(deposit) })
      ),
      owner
    );
  }
  return { svm, owner, agent, cranker, benes, pdas, assetPlan };
}

/** Create + init a mint, create the vault's canonical ATA, mint `amount` into it. */
export function fundVaultToken(svm: any, owner: Keypair, vault: PublicKey, decimals: number, amount: bigint) {
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  send(svm, createMintTx(svm, owner.publicKey, mintKp, decimals), owner, [mintKp]);
  const vaultAta = ataFor(mint, vault);
  const { ix } = createAtaIx(owner.publicKey, vault, mint);
  send(svm, new Transaction().add(ix, mintToIx(mint, vaultAta, owner.publicKey, amount)), owner);
  return { mint, vaultAta };
}

/** Create beneficiary ATAs (chunked ≤4 per tx) → returns their addresses. */
export function makeBeneAtas(svm: any, owner: Keypair, mint: PublicKey, owners: PublicKey[]) {
  const atas = owners.map((o) => ataFor(mint, o));
  for (let i = 0; i < owners.length; i += 4) {
    const tx = new Transaction();
    for (const o of owners.slice(i, i + 4)) tx.add(createAtaIx(owner.publicKey, o, mint).ix);
    send(svm, tx, owner);
  }
  return atas;
}
