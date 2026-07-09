import { getRpcUrl } from './core';

export interface AssetMeta {
  name?: string;
  symbol?: string;
  image?: string;
}

/**
 * Best-effort token/NFT metadata (name, symbol, logo) for everything a wallet
 * owns, via Helius DAS `getAssetsByOwner` through the RPC proxy (the Helius key
 * is injected server-side). NB: through the proxy, DAS wants NAMED-object params
 * (`params: { ownerAddress }`), NOT the array-wrapped form (`[{...}]`) the mobile
 * app uses against a direct Helius URL — that form 400s here.
 * Returns an empty map on any failure; callers must never let this hide assets.
 */
export async function fetchOwnerAssetMeta(ownerAddress: string): Promise<Map<string, AssetMeta>> {
  const map = new Map<string, AssetMeta>();
  try {
    const res = await fetch(getRpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'asset-meta',
        method: 'getAssetsByOwner',
        params: {
          ownerAddress,
          page: 1,
          limit: 1000,
          displayOptions: { showFungible: true, showNativeBalance: false, showZeroBalance: false },
        },
      }),
    });
    const json = await res.json();
    for (const item of json?.result?.items ?? []) {
      if (!item?.id) continue;
      const image =
        item.content?.links?.image || item.content?.files?.[0]?.cdn_uri || item.content?.files?.[0]?.uri;
      map.set(item.id, {
        name: item.content?.metadata?.name || undefined,
        symbol: item.token_info?.symbol || item.content?.metadata?.symbol || undefined,
        image: image || undefined,
      });
    }
  } catch {
    /* best-effort — leave the map empty */
  }
  return map;
}
