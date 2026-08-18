const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./atomic-write');

// The files a project might keep its local variables in, most specific first.
const CANDIDATES = ['.env.local', '.env.development.local', '.env.development', '.env'];

function resolveFile(dir) {
  for (const name of CANDIDATES) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  // Nothing there yet — .env.local is the one to create.
  return path.join(dir, CANDIDATES[0]);
}

function parseLine(line) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
  if (!match) return null;

  let value = match[2].trim();
  let quote = '';
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    quote = value[0];
    value = value.slice(1, -1);
  }
  return { key: match[1], value, quote };
}

function read(dir) {
  const file = resolveFile(dir);
  if (!fs.existsSync(file)) return { file, exists: false, vars: [] };

  const vars = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const parsed = parseLine(line);
    if (parsed) vars.push({ key: parsed.key, value: parsed.value });
  }
  return { file, exists: true, vars };
}

function formatValue(value, quote) {
  if (quote) return `${quote}${value}${quote}`;
  // Anything with whitespace or a # would be misread unquoted.
  if (/[\s#]/.test(value)) return `"${value}"`;
  return value;
}

/**
 * Writes the given variables back, editing lines in place. Comments, blank
 * lines and ordering survive, and a value keeps whatever quoting it had —
 * a .env is something a human reads, not a generated file.
 */
function write(file, vars) {
  const wanted = new Map(vars.map((v) => [v.key, v.value]));
  const seen = new Set();

  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n') : [];

  const lines = existing.map((line) => {
    const parsed = parseLine(line);
    if (!parsed) return line;

    // Dropped by the editor — take the line with it.
    if (!wanted.has(parsed.key)) return null;

    seen.add(parsed.key);
    const value = wanted.get(parsed.key);
    if (value === parsed.value) return line;

    const prefix = line.match(/^\s*(?:export\s+)?/)[0];
    return `${prefix}${parsed.key}=${formatValue(value, parsed.quote)}`;
  });

  const kept = lines.filter((line) => line !== null);

  const added = vars
    .filter((v) => v.key && !seen.has(v.key))
    .map((v) => `${v.key}=${formatValue(v.value, '')}`);

  if (added.length) {
    if (kept.length && kept[kept.length - 1].trim() !== '') kept.push('');
    kept.push(...added);
  }

  let output = kept.join('\n');
  if (!output.endsWith('\n')) output += '\n';

  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, output);

  return read(path.dirname(file));
}

module.exports = { read, write, resolveFile, CANDIDATES };
