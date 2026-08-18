// ── Secret redaction (0323) ──
// Anything that leaves the app as text — CLI stderr surfaced in a toast, a
// future diagnostics bundle (0360) — passes through here first. Originals
// on disk stay intact: redaction happens at the exit, not at capture.
// Two nets, line-oriented so context survives:
//   - key-name matches: KEY=..., "token": "...", Authorization: Bearer ...
//   - value-shape matches: long base64/hex runs that read as credentials
const KEY_NAMES =
  /(token|secret|password|passwd|api[-_]?key|auth|credential|private[-_]?key|access[-_]?key|client[-_]?secret|session[-_]?id|cookie|bearer|aws_[a-z_]+|gh[pousr]?_[a-z_]*|anthropic[a-z_]*|openai[a-z_]*)/i;

// KEY=value / KEY: value / "key": "value" — mask the value, keep the name.
const ASSIGNMENT =
  /([A-Za-z0-9_."'\- ]{0,64}?([A-Za-z0-9_\-."']+))(\s*[:=]\s*)("?)([^\s"',;]{4,})("?)/g;

// A bearer/basic header value.
const AUTH_HEADER = /((?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)\s+)(\S+)/gi;

// Bare high-entropy runs: 32+ chars of base64/hex alphabet with no spaces.
// Long enough that file paths and words stay untouched.
const BARE_CREDENTIAL = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{40,}(?![A-Za-z0-9+/=_-])/g;

// Known token prefixes are secrets whatever their length.
const KNOWN_PREFIXES = /\b(?:sk-|ghp_|gho_|ghu_|ghs_|ghr_|xox[bpars]-|AKIA)[A-Za-z0-9_-]{8,}\b/g;

function redactLine(line) {
  let out = line.replace(AUTH_HEADER, (m, lead) => `${lead}[redacted:auth]`);
  out = out.replace(ASSIGNMENT, (match, lead, key, sep, q1, value, q2) => {
    if (!KEY_NAMES.test(key)) return match;
    return `${lead}${sep}${q1}[redacted:${key.replace(/["']/g, '')}]${q2}`;
  });
  out = out.replace(KNOWN_PREFIXES, '[redacted:token]');
  out = out.replace(BARE_CREDENTIAL, (m) =>
    // A long run that is clearly a filesystem path or URL stays readable.
    m.includes('/') && /^[A-Za-z0-9._/-]+$/.test(m) ? m : '[redacted:credential]'
  );
  return out;
}

function redact(text) {
  return String(text || '')
    .split('\n')
    .map(redactLine)
    .join('\n');
}

module.exports = { redact };
