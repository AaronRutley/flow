// ── The event log (0360) ──
// One JSONL stream of lifecycle events under the flow root's logs, each
// line carrying its correlation handles (card, session, project) so a
// story can be followed across terminals, agents and servers. Redaction
// happens at write time here — this file exists to be copied out.
const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');
const { FLOW_ROOT } = require('./flow-root');

const FILE = path.join(FLOW_ROOT, 'logs', 'events.jsonl');
const MAX_BYTES = 2 * 1024 * 1024;

function logEvent(kind, fields = {}) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const entry = { t: new Date().toISOString(), kind, ...fields };
    fs.appendFileSync(FILE, `${redact(JSON.stringify(entry))}\n`);
    // A simple guillotine keeps the log bounded: over budget, keep the tail.
    const size = fs.statSync(FILE).size;
    if (size > MAX_BYTES) {
      const text = fs.readFileSync(FILE, 'utf-8');
      fs.writeFileSync(FILE, text.slice(-Math.floor(MAX_BYTES / 2)));
    }
  } catch (err) {
    // The log must never be the thing that fails.
  }
}

function tail(lines = 200) {
  try {
    return fs.readFileSync(FILE, 'utf-8').trim().split('\n').slice(-lines).join('\n');
  } catch (err) {
    return '';
  }
}

module.exports = { logEvent, tail, FILE };
