// Stamped before the first paint so a dark session never flashes light.
// Same rule as initTheme: a saved choice wins, otherwise dark. External
// file rather than inline (0320): the CSP allows no inline script.
document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark';
