// Line-oriented frontmatter. Deliberately not a YAML round trip: re-serialising
// reflows quoting, drops empty scalars like `completed:` and reorders keys, so
// every write to a card would show up as a spurious diff.

const FM_RE = /^---\n([\s\S]*?)\n---\n?/;

function parse(raw) {
  const match = raw.match(FM_RE);
  if (!match) return { data: {}, body: raw, raw: '' };

  const data = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([\w][\w_-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    data[kv[1]] = value;
  }

  return { data, body: raw.slice(match[0].length), raw: match[1] };
}

// Rewrites the given keys in place. Keys already present keep their position;
// new keys are appended after the last existing one.
function update(raw, changes) {
  const match = raw.match(FM_RE);
  if (!match) return raw;

  const lines = match[1].split('\n');
  const remaining = { ...changes };

  const rendered = lines.map((line) => {
    const kv = line.match(/^([\w][\w_-]*):/);
    if (!kv || !(kv[1] in remaining)) return line;
    const key = kv[1];
    const value = remaining[key];
    delete remaining[key];
    return format(key, value);
  });

  for (const [key, value] of Object.entries(remaining)) {
    rendered.push(format(key, value));
  }

  return `---\n${rendered.join('\n')}\n---\n${raw.slice(match[0].length)}`;
}

function format(key, value) {
  if (value === null || value === undefined || value === '') return `${key}:`;
  const str = String(value);
  // Plain integers stay unquoted so counters read as numbers. Anything with a
  // leading zero is an id and must keep its quotes, or 0008 becomes 8.
  const isPlainInteger = /^\d+$/.test(str) && !/^0\d/.test(str);
  const needsQuotes = !isPlainInteger && (/[:#"']/.test(str) || /^\d/.test(str));
  if (!needsQuotes) return `${key}: ${str}`;
  return `${key}: "${str.replace(/"/g, '\\"')}"`;
}

function build(data, body = '') {
  const lines = Object.entries(data).map(([k, v]) => format(k, v));
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

module.exports = { parse, update, build, format };
