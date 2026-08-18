// node-pty ships its macOS `spawn-helper` without the executable bit, and every
// pty.spawn posix_spawns that helper. Without +x, every terminal in the app
// fails with the unhelpful "posix_spawnp failed." Re-applied on postinstall
// because npm resets it.
const fs = require('fs');
const path = require('path');

const prebuilds = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');

if (!fs.existsSync(prebuilds)) process.exit(0);

for (const platform of fs.readdirSync(prebuilds)) {
  const helper = path.join(prebuilds, platform, 'spawn-helper');
  if (!fs.existsSync(helper)) continue;
  try {
    fs.chmodSync(helper, 0o755);
    console.log(`[flow] chmod +x ${path.relative(process.cwd(), helper)}`);
  } catch (err) {
    console.error(`[flow] could not chmod ${helper}:`, err.message);
  }
}
