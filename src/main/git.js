const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const sessions = require('./sessions');

function run(cwd, args, { tolerate = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, PATH: sessions.loginPath() },
    }).trim();
  } catch (err) {
    if (tolerate) return null;
    const detail = (err.stderr || err.stdout || err.message || '').toString().trim();
    throw new Error(detail || `git ${args[0]} failed`);
  }
}

function gh(cwd, args, { tolerate = false } = {}) {
  try {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, PATH: sessions.loginPath() },
    }).trim();
  } catch (err) {
    if (tolerate) return null;
    const detail = (err.stderr || err.stdout || err.message || '').toString().trim();
    throw new Error(detail || `gh ${args[0]} failed`);
  }
}

function isRepo(cwd) {
  return run(cwd, ['rev-parse', '--is-inside-work-tree'], { tolerate: true }) === 'true';
}

function hasRemote(cwd) {
  const remotes = run(cwd, ['remote'], { tolerate: true });
  return Boolean(remotes);
}

function currentBranch(cwd) {
  return run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { tolerate: true });
}

// The branch the repo considers its trunk. Falls back through the usual
// suspects when there is no origin/HEAD to ask.
function defaultBranch(cwd) {
  const symbolic = run(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
    tolerate: true,
  });
  if (symbolic) return symbolic.replace('refs/remotes/origin/', '');

  for (const candidate of ['main', 'master']) {
    if (run(cwd, ['rev-parse', '--verify', candidate], { tolerate: true })) return candidate;
  }
  return currentBranch(cwd);
}

// Worktrees live beside the repo, never inside it, so they never turn up in the
// repo's own status or file tree.
function worktreeRoot(repoPath, projectName) {
  return path.join(path.dirname(repoPath), '.flow-worktrees', projectName);
}

function addWorktree(repoPath, projectName, cardId, branch) {
  const dir = path.join(worktreeRoot(repoPath, projectName), cardId);
  if (fs.existsSync(dir)) return dir;

  fs.mkdirSync(path.dirname(dir), { recursive: true });

  // A branch that already exists is picked up where it stands — a card
  // started on an existing branch (0175), or reopened after its worktree was
  // removed, must never have that branch reset. Only a genuinely new branch
  // is cut from the trunk.
  const exists = run(repoPath, ['rev-parse', '--verify', '--quiet', branch], { tolerate: true });
  if (exists) run(repoPath, ['worktree', 'add', dir, branch]);
  else run(repoPath, ['worktree', 'add', '-B', branch, dir, defaultBranch(repoPath)]);
  return dir;
}

// Local branches, current first, for the start-on-existing-branch picker.
function listBranches(cwd) {
  const out = run(cwd, ['branch', '--sort=-committerdate', '--format=%(refname:short)'], {
    tolerate: true,
  });
  return out ? out.split('\n').filter(Boolean) : [];
}

// Switching refuses to lose anything (0227): a dirty checkout stays put and
// the error names the problem instead of git's paragraph.
function switchBranch(cwd, branch) {
  const clean = /^[\w./-]+$/.test(String(branch || ''));
  if (!clean) throw new Error('Not a branch name');
  const dirty = run(cwd, ['status', '--porcelain'], { tolerate: true });
  if (dirty) throw new Error('Uncommitted changes here — commit or stash first');
  run(cwd, ['checkout', branch]);
  return currentBranch(cwd);
}

function removeWorktree(repoPath, dir) {
  run(repoPath, ['worktree', 'remove', '--force', dir], { tolerate: true });
}

// Directories symlinked back to the main checkout instead of being installed
// again. node_modules is gigabytes per worktree; ten cards would be tens of
// gigabytes of identical files.
const SHARED_DIRS = ['node_modules', '.venv', 'vendor/bundle'];

// Build output is deliberately NOT shared. Two `next dev` processes writing one
// .next corrupt each other's CSS — that is the whole reason umami-wizzard's
// start.sh refuses to run a second server.
const NEVER_SHARED = ['.next', 'dist', 'build', '.turbo', '.cache'];

// Local config copied rather than linked, so a worktree can hold a different
// port or API key without editing the main checkout's file.
const COPIED_FILES = ['.env', '.env.local', '.env.development.local'];

/**
 * Wires a fresh worktree to the main checkout: heavy dependency directories are
 * symlinked, local config is copied, build output is left alone.
 *
 * @returns {{linked: string[], copied: string[], skipped: string[]}}
 */
function shareArtifacts(repoPath, worktreePath) {
  const linked = [];
  const copied = [];
  const skipped = [];

  for (const name of SHARED_DIRS) {
    const source = path.join(repoPath, name);
    const target = path.join(worktreePath, name);

    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(target) || isLink(target)) {
      skipped.push(name);
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(source, target, 'dir');
      linked.push(name);
    } catch (err) {
      skipped.push(`${name} (${err.message})`);
    }
  }

  for (const name of COPIED_FILES) {
    const source = path.join(repoPath, name);
    const target = path.join(worktreePath, name);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    try {
      fs.copyFileSync(source, target);
      copied.push(name);
    } catch (err) {
      skipped.push(`${name} (${err.message})`);
    }
  }

  return { linked, copied, skipped };
}

function isLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch (err) {
    return false;
  }
}

// A draft PR needs a commit the base does not have, so start the branch with an
// empty one. That is the cost of getting a PR number before any work exists.
function openDraftPr(worktreePath, branch, title) {
  if (!hasRemote(worktreePath)) {
    return { pr: '', url: '', skipped: 'no git remote' };
  }

  const ahead = run(worktreePath, ['rev-list', '--count', `@{u}..HEAD`], { tolerate: true });
  if (ahead === null) {
    run(worktreePath, ['commit', '--allow-empty', '-m', `start: ${title}`]);
  }

  const pushed = run(worktreePath, ['push', '-u', 'origin', branch], { tolerate: true });
  if (pushed === null) return { pr: '', url: '', skipped: 'push failed' };

  const existing = gh(worktreePath, ['pr', 'view', '--json', 'number,url'], { tolerate: true });
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      return { pr: String(parsed.number), url: parsed.url };
    } catch (err) {
      // Fall through and try to create one.
    }
  }

  const created = gh(
    worktreePath,
    ['pr', 'create', '--draft', '--title', title, '--body', `Card: ${title}`],
    { tolerate: true }
  );
  if (!created) return { pr: '', url: '', skipped: 'gh pr create failed' };

  const match = created.match(/\/pull\/(\d+)/);
  return { pr: match ? match[1] : '', url: created.split('\n').pop().trim() };
}

function prState(cwd, prNumber) {
  const out = gh(cwd, ['pr', 'view', String(prNumber), '--json', 'state,isDraft,url,title'], {
    tolerate: true,
  });
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch (err) {
    return null;
  }
}

module.exports = {
  run,
  gh,
  isRepo,
  hasRemote,
  currentBranch,
  defaultBranch,
  worktreeRoot,
  addWorktree,
  listBranches,
  switchBranch,
  removeWorktree,
  shareArtifacts,
  SHARED_DIRS,
  NEVER_SHARED,
  openDraftPr,
  prState,
};
