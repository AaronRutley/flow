// Decides what a terminal Enter-key event should do before xterm sees it.
// Shared between the renderer (as window.termKeys) and the smoke test (as a
// CommonJS module), so the key routing has tests without needing a DOM.
//
// Returns null to let xterm handle the event itself, or an object with the
// bytes to send instead — data '' means swallow the event and send nothing.
//
// The swallow-everything-but-keydown rule is the actual fix for the
// shift-enter-submits regression: Enter is the one key Chrome still fires
// keypress for, and xterm's keypress path only skips ctrl/meta combos, not
// shift. If the custom handler answers false only to the keydown, xterm's
// _keyPress sends a bare \r right after our newline — and Claude Code reads
// that \r as submit. Every event of an overridden combo has to be refused.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.termKeys = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // A newline wrapped in bracketed-paste markers: a shell and Claude Code both
  // take it as literal text, never as a key to act on.
  const PASTED_NEWLINE = '\x1b[200~\n\x1b[201~';
  // ESC+CR is what most terminals map Option+Return to; zsh and Claude Code
  // both accept it as a newline.
  const ESC_CR = '\x1b\r';

  function enterKeyOverride(event) {
    if (event.key !== 'Enter' || event.altKey) return null;
    const onlyShift = event.shiftKey && !event.metaKey && !event.ctrlKey;
    const cmdOrCtrl = (event.metaKey || event.ctrlKey) && !event.shiftKey;
    if (!onlyShift && !cmdOrCtrl) return null;
    if (event.type !== 'keydown') return { data: '' };
    return { data: onlyShift ? PASTED_NEWLINE : ESC_CR };
  }

  return { enterKeyOverride, PASTED_NEWLINE, ESC_CR };
});
