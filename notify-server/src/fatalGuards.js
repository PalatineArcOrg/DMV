// Fail-closed process guards (Phase 2). A genuinely uncaught fault → REDACTED fatal log + exit
// non-zero (systemd restarts with fresh state). Expected operational errors (RPC/balance/program/
// poll/executor) are caught at their LOCAL boundaries and never reach here. Shared by server.js and
// the child-process fatal-handler tests so the tests exercise the REAL logic. `exit`/`log` are
// injectable for testing.

/**
 * Shared sanitization contract (Phase 2). Strip secrets from a free-text operational error message
 * before logging — used by BOTH the fatal handlers AND every operational log path (RPC/crank/monitor/
 * boot errors), because RPC/Anchor error strings routinely embed a full provider URL with an api-key.
 * Redacts, in order: whole URLs (covering any embedded api-key query), credential fields whether
 * UNQUOTED (`key=v`, `key: v`) or QUOTED-JSON (`"key":"v"`, `"key" : "v"`), bearer tokens, PEM blocks.
 */
export function sanitize(input) {
  return String(input)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted-url]')
    // PEM blocks FIRST — a raw multi-line PEM as a credential VALUE (e.g. private_key=-----BEGIN...)
    // must be redacted whole before the key=value rule can consume just its `-----BEGIN` token.
    .replace(/-----BEGIN[\s\S]*?END[^-]*-----/g, '[redacted-key]')
    // QUOTED value FIRST — the value is quoted and may contain SPACES, COMMAS or ESCAPED quotes, so it
    // must be consumed through the matching closing quote (the unquoted rule below stops at a space/
    // comma and would leak `"password":"my secret phrase"`). Key quote optional; value quote required.
    // `(?:\\.|(?!\3)[^\\])*` = an escaped char OR any char that isn't the closing value-quote.
    .replace(
      /(["']?)(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|private[-_]?key|password|passwd|pwd)\1\s*[:=]\s*(["'])((?:\\.|(?!\3)[^\\])*)\3/gi,
      '$2=[redacted]',
    )
    // UNQUOTED value — consumed WHOLE, bounded by quote / comma / brace / end-of-line (NOT whitespace:
    // a value like `password=my secret phrase` must be redacted entirely, not left leaking ` secret
    // phrase` after the first space).
    .replace(
      /(["']?)(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|private[-_]?key|password|passwd|pwd)\1\s*[:=]\s*[^"',}\n]+/gi,
      '$2=[redacted]',
    )
    // FAIL-CLOSED fallback (LAST): a sensitive key + an OPENING quote with NO closing quote — a
    // malformed / truncated / concatenated error (sanitize() takes arbitrary free text, not only valid
    // JSON). The valid-quoted rule can't match it (no close) and the unquoted rule excludes quotes, so
    // the secret would leak. Redact from the opening quote to end-of-line. Runs last so it only catches
    // the UNTERMINATED remainder (completed quoted values were already redacted above).
    .replace(
      /(["']?)(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|private[-_]?key|password|passwd|pwd)\1\s*[:=]\s*["'][^\n]*/gi,
      '$2=[redacted]',
    )
    .replace(/\bbearer\s+\S+/gi, 'bearer [redacted]');
}

export function installFatalGuards({
  label = 'server',
  exit = (code) => process.exit(code),
  log = (...a) => console.error(...a),
} = {}) {
  // Preserve the STACK for an Error (the file:line frames are what make a fatal crash diagnosable) but
  // still run it through sanitize() so a credential/URL/PEM embedded in the message or a frame can never
  // leak. Non-Errors fall back to their string form (also sanitized).
  const redact = (v) => sanitize(v instanceof Error ? (v.stack || v.message) : typeof v === 'string' ? v : String(v));
  process.on('unhandledRejection', (reason) => {
    log(`[${label}] FATAL unhandledRejection: ${redact(reason)}`);
    exit(1);
  });
  process.on('uncaughtException', (err) => {
    log(`[${label}] FATAL uncaughtException: ${redact(err)}`);
    exit(1);
  });
}
