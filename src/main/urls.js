// ── One URL policy for everything that leaves the app (0316) ──
// The window-open guard, will-navigate and the direct open-external IPC all
// answer the same question, so they ask the same function. Parsed with the
// WHATWG parser rather than a regex: `new URL()` rejects malformed strings
// and scheme tricks a prefix match can be talked past, and the protocol
// comparison is exact.
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function isSafeExternalUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ''));
  } catch (err) {
    return false;
  }
  return ALLOWED_PROTOCOLS.has(parsed.protocol);
}

module.exports = { isSafeExternalUrl };
