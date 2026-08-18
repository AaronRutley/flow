// Lint policy (0335): the recommended set, tuned to the codebase's real
// shape — classic scripts sharing globals in the renderer, CommonJS in the
// main process — so the lint catches mistakes instead of fighting the
// architecture. Errors gate the pre-commit; warnings are allowed to exist.
const js = require('@eslint/js');

const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  __dirname: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  localStorage: 'readonly',
  requestAnimationFrame: 'readonly',
  performance: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  ResizeObserver: 'readonly',
  URL: 'readonly',
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'local/**',
      'projects/**',
      'lib/**', // vendored
      'docs/**',
      '.git-backup/**',
    ],
  },
  js.configs.recommended,
  {
    rules: {
      // House style: err in catch blocks is often documentation, not use,
      // and terminal code strips control characters for a living.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      // Defensive `let x = null; try { x = ... }` initialisation is house
      // style, and wrapping every rethrow in `cause` is ceremony this
      // codebase does not carry.
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['main.js', 'preload.js', 'src/main/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: nodeGlobals },
  },
  {
    // The esbuild entry uses import syntax despite its .js name, and
    // targets the browser bundle.
    files: ['scripts/**/*.mjs', 'scripts/toastui-entry.js'],
    languageOptions: { sourceType: 'module', globals: { ...nodeGlobals, window: 'writable' } },
  },
  {
    // The renderer is classic scripts loaded in order: each file's top-level
    // functions are the next file's globals. Cross-file identifiers are the
    // architecture (card 0345 revisits it), not something lint can see.
    files: ['src/renderer/**/*.js', 'setup.js'],
    languageOptions: { sourceType: 'script', globals: browserGlobals },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
];
