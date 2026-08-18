# Third-party licenses

flow is MIT licensed (see LICENSE). Every dependency it ships with or builds
against uses a permissive license compatible with MIT. Audited 2026-08-18
against the installed versions; nothing here is GPL, AGPL or otherwise
copyleft.

## Runtime dependencies

| Package | License | Notes |
| --- | --- | --- |
| @hugeicons/core-free-icons | MIT | A subset is baked into `lib/icons.js` by `scripts/extract-icons.mjs` |
| @toast-ui/editor | MIT | Bundled into `lib/toastui-editor-all.js` by the vendor script |
| @xterm/xterm, addon-fit, addon-web-links | MIT | |
| chokidar | MIT | |
| dompurify | MPL-2.0 OR Apache-2.0 | Dual-licensed; used under Apache-2.0 |
| highlight.js | BSD-3-Clause | Permissive; keep its notice with redistributions |
| marked | MIT | |
| node-pty | MIT | Native module, rebuilt per Electron version |
| sortablejs | MIT | |
| turndown | MIT | |

## Build / dev dependencies

| Package | License | Notes |
| --- | --- | --- |
| electron | MIT | |
| electron-builder | MIT | |
| eslint, @eslint/js | MIT | |
| prettier | MIT | |
| sharp | Apache-2.0 | Dev-time icon rendering only; not shipped |

## Obligations

- MIT and BSD-3-Clause ask that copyright and license notices travel with
  copies. Packaged builds include dependency license texts from
  `node_modules`; the two vendored bundles (`lib/icons.js`,
  `lib/toastui-editor-all.js`) note their source and license in this file.
- Apache-2.0 (dompurify, sharp) adds a patent grant and NOTICE handling.
  dompurify ships with the app and its license text travels in
  `node_modules`; sharp is dev-time only and not distributed.
