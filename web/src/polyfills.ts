// Browser polyfills for the Node globals that @solana/web3.js + anchor + the
// reused RN core expect. Imported FIRST in main.tsx so these exist before any
// module that touches Buffer/process is evaluated.
import { Buffer } from 'buffer';

const g = globalThis as unknown as {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
  process?: { env: Record<string, string | undefined>; browser?: boolean; version?: string };
};

g.Buffer = g.Buffer || Buffer;
g.global = g.global || globalThis;
// EXPO_PUBLIC_* reads are replaced at build time (see vite.config define); this
// is just a safety net so any other `process.env.X` read yields undefined, not a
// ReferenceError.
g.process = g.process || { env: {}, browser: true, version: '' };
