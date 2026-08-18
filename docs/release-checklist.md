# Release checklist

The whole ritual, in order, so a release next month by a tired person comes
out the same as this one. Steps marked (gap) are known-missing capability
tracked on the board; do them once their cards land.

## 1. Decide and stamp

- [ ] `npm test` green on a clean checkout
- [ ] Bump `version` in package.json (semver: breaking / feature / fix)
- [ ] Move the changelog's Unreleased block under the new version with today's
      date, and start a fresh Unreleased block
- [ ] Commit: `release: vX.Y.Z`

## 2. Build and publish (automated since 0404)

- [ ] `git tag vX.Y.Z && git push origin vX.Y.Z` — the release workflow
      builds on a clean macOS runner, runs the suite, and publishes dmg,
      zip and SHASUMS256.txt to the GitHub release
- [ ] Watch the `release` action go green; the Update pill reaches existing
      installs on their next launch
- [ ] Building locally instead: `npm run build`, then attach `dist/` files
      to the release by hand

## 3. Prove it on a clean profile

- [ ] Create (or reuse) a fresh macOS user account with no Flow folder
- [ ] Install from the dmg exactly as the README says, quarantine dance included
- [ ] First launch: the setup window asks for a folder; pick one, app relaunches
      into an empty board
- [ ] Create a card, open its session (needs tmux + claude present), close and
      reopen the app, confirm the session resumes
- [ ] Startup marks land in `<flow-root>/logs/startup.log` and sit inside
      `scripts/perf-budget.json`

## 4. Privacy pass

- [ ] `grep -R "http" dist/mac-arm64/Flow.app/Contents/Resources --include='*.js' -l`
      — the only outbound call in the app is the GitHub releases check
- [ ] Skim `<flow-root>/logs/` from the test run: nothing secret-shaped in
      proc.log or startup.log (the 0323 redactor fronts exports, but eyes on)
- [ ] Crash logs stay local (`uploadToServer: false` in main.js)

## 5. Recovery test

- [ ] Force-quit the app mid-edit of a card; relaunch; the card file is whole
      (atomic writes, 0330) and the board loads
- [ ] Delete a card file by hand while the app runs; the board heals on the
      next watcher tick without crashing

## 6. Publish

- [ ] Refresh the README screenshots / demo video if the UI moved this release
- [ ] Known issues: list anything real in the release notes, not in a drawer
- [ ] `git tag vX.Y.Z && git push origin vX.Y.Z`
- [ ] GitHub release: attach dmg, zip and SHASUMS256.txt, paste the changelog
      block, mark pre-release if it is one
- [ ] Source archive is the tag; no extra artifact needed
- [ ] Install the published dmg over your own copy and use it for a day
