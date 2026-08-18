// ── Static icons ──
function paintStaticIcons() {
  applySectionNames();
  // The shelf doors are header icons since 0383; their counts ride the
  // tooltip, painted by loadBoard. View archive wears the clock and the
  // sweep the box, so the two never read as the same act.
  paint('#foot-backlog', icon('inbox', 15));
  paint('#foot-archive', icon('history', 15));
  paint('#archive-done-button', icon('archive', 15));
  paint('#quick-add-button', icon('plus', 17));
  // Actions (0393, renaming 0380's Quick start): the menu items wear their
  // names; the tips explain what firing one actually does.
  paint('#term-quick-start', `${icon('magic', 14)}<span>Actions</span>`);
  paint('#term-clear-todos', `${icon('tickCircle', 14)}<span>Process to-dos</span>`);
  paint('#term-draft-pr', `${icon('pullRequest', 14)}<span>Draft PR</span>`);
  paint('#term-info', icon('info', 14));
  paint('#card-add-save-only', `${icon('tick', 15)}<span>Save</span>`);
  paint('#card-add-save', `${icon('magic', 15)}<span>Save and shape</span>`);
  paint('#kb-doc-close', icon('cancel', 15));
  paint('#kb-focus', icon('expand', 15));
  paint('#kb-add-button', icon('plus', 15));
  paint('#kb-open-browser', icon('link', 15));
  paint('#kb-tell-agent', icon('terminal', 15));
  paint('#kb-reveal-doc', icon('folder', 15));
  paint('#kb-delete-doc', icon('archive', 15));
  paint('#global-term-button', icon('terminal', 15));
  paint('#kb-term-button', icon('terminal', 15));
  // Hide slides the pane away to the right, and wears that direction (0380).
  paint('#board-term-close', `${icon('arrowRight', 14)}<span>Hide</span>`);
  paint('.search-icon', icon('search', 17));
  paint('#update-agent .pill-icon', icon('magic', 16));
  paint('.project-caret', icon('chevronDown', 15));
  paint('#card-modal-close', icon('cancel', 15));
  paint('#settings-close', icon('cancel', 22));
  paint('#open-settings', icon('settings', 17));
  paint('#icon-upload', icon('plus', 14));
  paint('#card-modal-shape', icon('magic', 15));
  paint('#card-modal-move', icon('kanban', 15));
  paint('#card-modal-archive', icon('archive', 15));
  paint('#card-session-log', icon('history', 15));

  for (const el of document.querySelectorAll('.column-icon')) {
    el.innerHTML = icon(el.dataset.icon, 19);
  }
  for (const el of document.querySelectorAll('.shelf-close')) {
    el.innerHTML = icon('cancel', 15);
  }
}
