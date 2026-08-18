// ── Branch & env ──
// The toolbar branch switcher and env panel retired to the plugin archive
// (0376, see local/plugins/branch-and-env.md). The refresh hooks stay as
// no-ops because loadBoard, showView and settings-save still call them —
// they become real again when the plugin returns.
function refreshGitButton() {}

function refreshEnvButton() {}

// ── The Update pill ──
// Not part of the plugin: this stayed behind when Branch & env left.
// The dev pill (0228): dev builds no longer reload themselves on every
// save — the main process only says something changed, and this button
// wears the news until clicked. Renderer-only changes reload the page; a
// main-process change relaunches the app, once, on purpose.
if (window.api.onDevUpdate) {
  window.api.onDevUpdate(({ main, count }) => {
    const button = $('update-button');
    if (!button) return;
    button.classList.remove('hidden');
    button.innerHTML = `${icon('refresh', 15)}<span>Update flow</span>`;
    button.dataset.tip = `${count} file${count === 1 ? '' : 's'} changed — ${
      main ? 'relaunch Flow' : 'reload Flow'
    }`;
  });
}

// A packaged build's nag (0308): only for a major or minor release, and
// the pill is a door to the download page, not a self-installer. Since
// 0342 the tip says where you stand and what is in the update, so the
// choice to click out is informed.
if (window.api.onReleaseUpdate) {
  window.api.onReleaseUpdate(({ version, current, notes, url }) => {
    const button = $('update-button');
    if (!button) return;
    button.classList.remove('hidden');
    button.dataset.releaseUrl = url;
    button.innerHTML = `${icon('refresh', 15)}<span>Update flow</span>`;
    const firstNote = String(notes || '').split('\n').find((line) => line.trim()) || '';
    button.dataset.tip = `flow ${version} is out${current ? ` (you run ${current})` : ''}${
      firstNote ? ` — ${firstNote.slice(0, 120)}` : ''
    } — opens the download page`;
  });
}

on('update-button', 'click', () => {
  const button = $('update-button');
  if (button && button.dataset.releaseUrl) {
    window.api.openExternal(button.dataset.releaseUrl);
    return;
  }
  window.api.applyDevUpdate();
});
