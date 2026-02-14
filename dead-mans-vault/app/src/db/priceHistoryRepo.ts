import { getDb } from './database';

export async function saveDailyPrice(mint: string, price: number): Promise<void> {
  const db = getDb();
  await db.runAsync(
    "INSERT OR IGNORE INTO price_history (mint, price, date) VALUES (?, ?, date('now'))",
    [mint, price],
  );
}

export async function getPreviousPrice(mint: string): Promise<number | null> {
  const db = getDb();
  const row = await db.getFirstAsync<{ price: number }>(
    "SELECT price FROM price_history WHERE mint = ? AND date = date('now', '-1 day')",
    [mint],
  );
  return row?.price ?? null;
}

export async function getPriceChanges(
  mints: string[],
): Promise<Record<string, number | null>> {
  const result: Record<string, number | null> = {};
  for (const mint of mints) {
    const prev = await getPreviousPrice(mint);
    result[mint] = prev;
  }
  return result;
}
