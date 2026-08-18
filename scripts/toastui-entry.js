// Entry for the vendored editor bundle (0253). The npm dist of
// @toast-ui/editor is the externals build: loaded from a plain script tag
// it resolves its ProseMirror dependencies to undefined and Editor never
// exists. Bundling here inlines them. Regenerate lib/toastui-editor-all.js
// with `npm run vendor:editor` after upgrading the editor.
import Editor from '@toast-ui/editor';
window.toastui = window.toastui || {};
window.toastui.Editor = Editor;
