import { getRandomValues as expoCryptoGetRandomValues } from "expo-crypto";
import { Buffer } from "buffer";

global.Buffer = Buffer;

// structuredClone polyfill — Hermes doesn't support it, but @coral-xyz/anchor uses it
if (typeof global.structuredClone === "undefined") {
  global.structuredClone = function structuredClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  };
}

// getRandomValues polyfill
class Crypto {
  getRandomValues = expoCryptoGetRandomValues;
}

const webCrypto = typeof crypto !== "undefined" ? crypto : new Crypto();

(() => {
  if (typeof crypto === "undefined") {
    Object.defineProperty(global, "crypto", {
      configurable: true,
      enumerable: true,
      get: () => webCrypto,
    });
  }
})();
