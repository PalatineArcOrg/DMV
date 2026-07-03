/**
 * Fetch wrapper with exponential backoff on HTTP 429 (rate-limit).
 * Used for all external API calls: Helius, Pyth, Jupiter.
 */

import { useRpcStatusStore } from '../store/useRpcStatusStore';

const DEFAULT_MAX_RETRIES = 3;

export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429) return response;

    // Rate-limited — surface a "network busy" hint to the user (see RpcStatusBanner).
    useRpcStatusStore.getState().reportRateLimited();

    // Exponential backoff: 200ms, 400ms, 800ms  + random jitter 0-100ms
    const delay = 200 * Math.pow(2, attempt) + Math.random() * 100;
    await new Promise((r) => setTimeout(r, delay));
  }

  // Final attempt — let caller handle any error
  return fetch(url, options);
}

/**
 * JSON-RPC 2.0 helper with retry logic. Used for Helius RPC and DAS API calls.
 * Returns the parsed `result` field.
 */
export async function rpcWithRetry<T = unknown>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<T> {
  const response = await fetchWithRetry(
    rpcUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: method,
        method,
        params,
      }),
    },
    maxRetries,
  );

  if (!response.ok) {
    throw new Error(`RPC ${method} failed: HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    const msg = data.error.message || JSON.stringify(data.error);
    // Some providers return a rate-limit as a JSON-RPC error (HTTP 200) rather than 429.
    if (data.error.code === 429 || /rate.?limit|too many request/i.test(msg)) {
      useRpcStatusStore.getState().reportRateLimited();
    }
    throw new Error(`RPC ${method} error: ${msg}`);
  }

  return data.result as T;
}
