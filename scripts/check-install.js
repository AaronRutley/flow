// `npm start` on a fresh clone with no install dies as
// `sh: electron: command not found`, which reads like a broken machine
// rather than a skipped step (0460). This runs first (npm's prestart /
// predev hook), says the actual fix, and stops before sh gets the chance.
try {
  require.resolve('electron');
} catch (err) {
  console.error(
    [
      '',
      'Flow needs its dependencies installed first:',
      '',
      '  npm install',
      '',
      'then run `npm start` again.',
      '',
    ].join('\n')
  );
  process.exit(1);
}

// A fresh machine can reach `npm start` with the stock Electron bundle —
// postinstall interrupted, or electron reinstalled since (0479). Branding is
// idempotent and exits fast when already applied, so it runs before every
// launch rather than trusting install-time alone. Best-effort: an unbranded
// app still works, it just says Electron.
try {
  require('./brand-dev-app.js');
} catch (err) {
  console.error('[brand] could not brand the dev app:', err.message);
}
