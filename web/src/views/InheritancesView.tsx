import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useInheritances } from '../hooks/useInheritances';
import { useClaim } from '../hooks/useClaim';
import { InheritanceCard } from '../components/InheritanceCard';

export function InheritancesView() {
  const { connected } = useWallet();
  const { items, loading, error, refresh, importByOwner } = useInheritances();
  const { state: claim, claim: runClaim, reset } = useClaim();

  const [ownerInput, setOwnerInput] = useState('');
  const [importErr, setImportErr] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  async function onImport() {
    setImportErr(null);
    setImporting(true);
    try {
      await importByOwner(ownerInput);
      setOwnerInput('');
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setImporting(false);
    }
  }

  async function onClaim(owner: string) {
    reset();
    await runClaim(owner);
    refresh();
  }

  if (!connected) {
    return (
      <section className="empty panel rise" style={{ paddingBottom: 40 }}>
        <p className="eyebrow">Beneficiary</p>
        <h1 className="h1" style={{ margin: '8px 0 0' }}>Claim what's left to you</h1>
        <p className="lead">
          If someone left you crypto in a Dead Man's Vault, connect your wallet to see it. When their switch fires, you
          distribute the estate yourself — the program sends every beneficiary their exact share. You pay only network fees.
        </p>
        <div style={{ marginTop: 26, display: 'flex', justifyContent: 'center' }}>
          <WalletMultiButton />
        </div>
      </section>
    );
  }

  return (
    <div className="rise">
      <header style={{ marginBottom: 22 }}>
        <p className="eyebrow">Beneficiary</p>
        <h1 className="h1" style={{ margin: '8px 0 0' }}>Inheritances left to you</h1>
        <p className="lead">
          When an owner's switch fires and grace elapses, you can distribute the whole estate. You only pay network fees.
        </p>
      </header>

      {(claim.running || claim.done || claim.error) && (
        <div className={`banner ${claim.error ? 'err' : 'ok'}`}>
          {claim.running && (
            <span>Distributing… {claim.step ? `“${claim.step}”` : ''} {claim.total > 0 ? `(step ${claim.index + 1}/${claim.total})` : ''}</span>
          )}
          {claim.done && <span style={{ color: 'var(--mint)' }}>Done — estate distributed in {claim.done.steps} step(s).</span>}
          {claim.error && <span>{claim.error}</span>}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span className="eyebrow">{loading ? 'Loading…' : `${items.length} inheritance${items.length === 1 ? '' : 's'}`}</span>
        <button className="btn btn-ghost btn-sm" onClick={refresh}>Refresh</button>
      </div>

      {error && <p style={{ color: 'var(--amber)', fontSize: 13 }}>{error}</p>}

      {items.length > 0 && (
        <div className="cards">
          {items.map((item) => (
            <InheritanceCard key={item.owner} item={item} busy={claim.running} onClaim={onClaim} />
          ))}
        </div>
      )}

      {!loading && items.length === 0 && (
        <p className="dim" style={{ fontSize: 13.5, margin: '4px 0 0' }}>
          Nothing found automatically. If you know the owner's wallet address, look it up below.
        </p>
      )}

      <div className="panel panel-pad" style={{ marginTop: 28, maxWidth: 560 }}>
        <h3 className="eyebrow" style={{ marginBottom: 4 }}>Look up by owner address</h3>
        <p className="dim" style={{ fontSize: 12.5, margin: '0 0 12px', lineHeight: 1.5 }}>
          Vaults that aren't registered for notifications won't appear automatically. Paste the owner's wallet address to
          check on-chain.
        </p>
        <div className="field">
          <input className="input" value={ownerInput} onChange={(e) => setOwnerInput(e.target.value)} placeholder="Owner wallet address" />
          <button className="btn btn-soft" disabled={!ownerInput.trim() || importing} onClick={onImport}>
            {importing ? '…' : 'Check'}
          </button>
        </div>
        {importErr && <p style={{ color: 'var(--amber)', fontSize: 12.5, marginTop: 8 }}>{importErr}</p>}
      </div>
    </div>
  );
}
