// Pulls the handful of hugeicons we use into a single classic script, so the
// renderer does not have to load a 53MB barrel or run a bundler.
import fs from 'fs';
import path from 'path';

const ROOT = path.join(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'node_modules/@hugeicons/core-free-icons/dist/esm');
const OUT = path.join(ROOT, 'lib/icons.js');

const WANTED = {
  circle: 'CircleIcon',
  record: 'RecordIcon',
  tick: 'Tick02Icon',
  search: 'Search01Icon',
  inbox: 'InboxIcon',
  book: 'BookOpen01Icon',
  file: 'File02Icon',
  play: 'PlayIcon',
  moon: 'Moon02Icon',
  sun: 'Sun03Icon',
  plus: 'PlusSignIcon',
  cancel: 'Cancel01Icon',
  magic: 'AiMagicIcon',
  terminal: 'ComputerTerminal01Icon',
  kanban: 'KanbanIcon',
  cards: 'Cards02Icon',
  branch: 'GitBranchIcon',
  pullRequest: 'GitPullRequestIcon',
  refresh: 'RefreshIcon',
  folderAdd: 'FolderAddIcon',
  folder: 'Folder01Icon',
  chevronDown: 'ArrowDown01Icon',
  arrowRight: 'ArrowRight01Icon',
  analytics: 'Analytics01Icon',
  star: 'StarIcon',
  starOff: 'StarOffIcon',
  drag: 'DragDropVerticalIcon',
  server: 'ServerStack01Icon',
  variable: 'VariableIcon',
  plusSmall: 'PlusSignIcon',
  info: 'InformationCircleIcon',
  tickCircle: 'CheckmarkCircle02Icon',
  settings: 'Settings01Icon',
  contrast: 'ContrastIcon',
  archive: 'Archive02Icon',
  expand: 'ArrowExpand01Icon',
  sidebar: 'SidebarLeftIcon',
  sidebarRight: 'SidebarRight01Icon',
  history: 'Clock01Icon',
  copy: 'Copy01Icon',
  heading: 'HeadingIcon',
  bold: 'TextBoldIcon',
  italic: 'TextItalicIcon',
  listBullet: 'LeftToRightListBulletIcon',
  listNumber: 'LeftToRightListNumberIcon',
  checkList: 'CheckListIcon',
  link: 'Link01Icon',
  sourceCode: 'SourceCodeIcon',
};

const icons = {};

for (const [alias, file] of Object.entries(WANTED)) {
  const full = path.join(SRC, `${file}.js`);
  if (!fs.existsSync(full)) {
    console.error(`missing: ${file}`);
    process.exit(1);
  }
  const mod = await import(`file://${full}`);
  icons[alias] = mod.default.map(([tag, attrs]) => {
    const { key, ...rest } = attrs;
    return [tag, rest];
  });
}

const banner = `// Generated from @hugeicons/core-free-icons — do not edit by hand.
// Regenerate with the extract script if the icon set changes.
`;

const body = `window.HUGEICONS = ${JSON.stringify(icons, null, 2)};

// Renders an icon as an inline SVG string. Stroke colour follows currentColor,
// so an icon takes the colour of whatever it sits inside.
window.icon = function icon(name, size = 18) {
  const parts = window.HUGEICONS[name];
  if (!parts) return '';
  const children = parts
    .map(([tag, attrs]) => {
      const rendered = Object.entries(attrs)
        .map(([k, v]) => {
          const attr = k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
          return \`\${attr}="\${v}"\`;
        })
        .join(' ');
      return \`<\${tag} \${rendered} />\`;
    })
    .join('');
  return \`<svg class="icon" width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">\${children}</svg>\`;
};
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, banner + body, 'utf-8');
console.log(`wrote ${OUT} with ${Object.keys(icons).length} icons`);
