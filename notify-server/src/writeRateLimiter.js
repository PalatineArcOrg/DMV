// Dedicated write-endpoint rate limiter (WP3) for /register + /deregister and the
// admin routes. Fixed-window, clock-injected, dependency-free, bounded memory.
// Separate from the public-read and RPC limiters. Keys are only ip / owner / vault
// / sha256(token) / admin-ip — never a plaintext token, nonce, or signature.
//
// Ordering contract (enforced by the route): the IP window is consumed BEFORE any
// signature verification / RPC / DB access; the owner/vault/tokenHash facet windows
// are consumed BEFORE RPC / DB mutation. Legacy and signed attempts SHARE the
// owner/vault/token buckets.

const IP_WINDOW_MS = 60_000;
const IP_MAX = 30;
const FACET_WINDOW_MS = 600_000; // 10 min
const OWNER_MAX = 10;
const VAULT_MAX = 10;
const TOKEN_MAX = 6;
const ADMIN_WINDOW_MS = 60_000;
const ADMIN_MAX = 20;
const MAP_CAP = 50_000; // per-bucket-map entry cap (DoS bound)

export function makeWriteRateLimiter({ now }) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const ip = new Map();
  const owner = new Map();
  const vault = new Map();
  const token = new Map();
  const adminIp = new Map();
  const maps = [ip, owner, vault, token, adminIp];

  function pruneMap(map, t) {
    for (const [k, b] of map) if (t >= b.resetAt) map.delete(k);
  }
  function sweep() {
    const t = clock();
    for (const m of maps) pruneMap(m, t);
  }
  // Charge one hit against a fixed-window bucket. Returns {ok, retryAfter}.
  function hit(map, key, max, windowMs) {
    const t = clock();
    if (map.size > MAP_CAP) pruneMap(map, t); // bound memory before inserting a new key
    let b = map.get(key);
    if (!b || t >= b.resetAt) {
      b = { count: 0, resetAt: t + windowMs };
      map.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - t) / 1000)) };
    }
    return { ok: true, retryAfter: 0 };
  }

  return {
    checkIp: (k) => hit(ip, String(k), IP_MAX, IP_WINDOW_MS),
    checkOwner: (k) => hit(owner, String(k), OWNER_MAX, FACET_WINDOW_MS),
    checkVault: (k) => hit(vault, String(k), VAULT_MAX, FACET_WINDOW_MS),
    // key MUST be a SHA-256 hex string (never a plaintext token).
    checkTokenHash: (k) => hit(token, String(k), TOKEN_MAX, FACET_WINDOW_MS),
    checkAdminIp: (k) => hit(adminIp, String(k), ADMIN_MAX, ADMIN_WINDOW_MS),
    /**
     * Check the safe-to-extract facets in order (owner → vault → tokenHash),
     * returning the FIRST failure without revealing which facet it was. Undefined
     * facets are skipped (e.g. deregister has no tokenHash). Every provided facet
     * that is checked before a failure is still consumed (fixed-window semantics).
     */
    checkFacets: ({ owner: o, vault: v, tokenHash: h }) => {
      if (o !== undefined) {
        const r = hit(owner, String(o), OWNER_MAX, FACET_WINDOW_MS);
        if (!r.ok) return r;
      }
      if (v !== undefined) {
        const r = hit(vault, String(v), VAULT_MAX, FACET_WINDOW_MS);
        if (!r.ok) return r;
      }
      if (h !== undefined) {
        const r = hit(token, String(h), TOKEN_MAX, FACET_WINDOW_MS);
        if (!r.ok) return r;
      }
      return { ok: true, retryAfter: 0 };
    },
    sweep,
    // Test/introspection only — sizes, never contents.
    sizes: () => ({ ip: ip.size, owner: owner.size, vault: vault.size, token: token.size, adminIp: adminIp.size }),
  };
}
