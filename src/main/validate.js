// ── IPC argument validation (0321) ──
// Small explicit combinators, no dependency: each IPC channel declares the
// shape of its arguments once, and the boundary refuses anything else with
// a stable public reason before a handler runs. Checks return null when the
// value passes or a short reason string when it does not; reasons name the
// expectation, never the offending value, so nothing sensitive echoes back.
function str(max = 4096) {
  return (v) => (typeof v === 'string' && v.length <= max ? null : `string up to ${max}`);
}

function optStr(max = 4096) {
  return (v) => (v === undefined || v === null || v === '' ? null : str(max)(v));
}

function bool() {
  return (v) => (typeof v === 'boolean' ? null : 'boolean');
}

function optBool() {
  return (v) => (v === undefined || v === null ? null : bool()(v));
}

function num(max = Number.MAX_SAFE_INTEGER) {
  return (v) => (Number.isFinite(v) && Math.abs(v) <= max ? null : `number up to ${max}`);
}

function strOrNum(max = 64) {
  return (v) =>
    (typeof v === 'string' && v.length <= max) || (Number.isFinite(v) && String(v).length <= max)
      ? null
      : `string or number up to ${max}`;
}

function oneOf(...allowed) {
  return (v) => (allowed.includes(v) ? null : `one of ${allowed.join(', ')}`);
}

function arrOf(item, maxLen = 1000) {
  return (v) => {
    if (!Array.isArray(v) || v.length > maxLen) return `array up to ${maxLen}`;
    for (const entry of v) {
      const reason = item(entry);
      if (reason) return `array of (${reason})`;
    }
    return null;
  };
}

// A plain data object: no functions, a sane key count. Contents are the
// handler's business (patchCard whitelists its own fields); the boundary
// only refuses non-objects and absurd payloads.
function obj(maxKeys = 64) {
  return (v) =>
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).length <= maxKeys
      ? null
      : `object up to ${maxKeys} keys`;
}

function optObj(maxKeys = 64) {
  return (v) => (v === undefined || v === null ? null : obj(maxKeys)(v));
}

// Binary payloads (attachment bytes): any array-buffer-shaped thing under
// the cap. Structured clone delivers Uint8Array/ArrayBuffer/Buffer.
function bytes(maxBytes = 25 * 1024 * 1024) {
  return (v) => {
    const size =
      v instanceof ArrayBuffer
        ? v.byteLength
        : v && typeof v.byteLength === 'number'
          ? v.byteLength
          : null;
    return size !== null && size <= maxBytes ? null : `binary up to ${maxBytes} bytes`;
  };
}

// Validates a channel's argument list against its declared schema: every
// declared position checked, no undeclared extras allowed.
function check(args, schema) {
  if (!Array.isArray(schema)) return 'undeclared channel';
  if (args.length > schema.length) return `at most ${schema.length} arguments`;
  for (let i = 0; i < schema.length; i += 1) {
    const reason = schema[i](args[i]);
    if (reason) return `argument ${i + 1}: ${reason}`;
  }
  return null;
}

module.exports = { str, optStr, bool, optBool, num, strOrNum, oneOf, arrOf, obj, optObj, bytes, check };
