# Releasing homebridge-trane-nexia

Releases are published by GitHub Actions: the **Release** workflow ([.github/workflows/release.yml](../../.github/workflows/release.yml)) runs the full CI gate, publishes to npm with **trusted publishing** (no token anywhere, with a provenance attestation), and creates the GitHub release with notes taken from `CHANGELOG.md`. You prepare the release commit, merge it, and press one button.

**Publishing is public and a version number can never be reused.** Pushing a `vX.Y.Z` tag, or running the workflow with *publish* ticked, IS publishing. Agents don't do either without your explicit yes in chat. Extend this file in place; don't duplicate it.

Facts here were checked against the official docs on 2026-11-25 (npm docs: trusted publishing, staged publishing, access tokens; Homebridge `plugins` wiki: Verified Plugins). npm's publishing rules changed twice in 2025-2026, so re-check them if a year has passed.

## How a release flows

```
 you / an agent                         GitHub Actions: Release workflow
 ──────────────                         ─────────────────────────────────
 1  pick the version
 2  node scripts/release.js prepare X.Y.Z   (changelog + versions)
 3  PR → CI green → merge to main
 4  Run workflow (publish ticked)  ───►  CI gate on Node 18, 20, 22, 24, 26
    or push tag vX.Y.Z                    release checks (tag = version, changelog section, lockfile, on main)
                                          npm test → npm publish (OIDC, provenance)
                                          GitHub release + tag, notes from CHANGELOG.md
 5  update the plugin on the NAS; reply to issues
```

## One-time setup: trusted publishing (done 2026-11-25, for v1.1.3)

This is the order that worked. GitHub only offers **Run workflow** for a workflow file that is on the default branch, so nothing can be rehearsed or published until the pipeline is merged to `main`.

1. **Merge the pull request that adds the pipeline** (CI green on Node 18-26).
2. **Prepare the release in its own small PR** (under "Each release", steps 1-3). Until it is merged, `[Unreleased]` still has entries and the release check correctly refuses.
3. **Rehearse. Safe, publishes nothing.** Actions → **Release** → *Run workflow* with *publish* unticked, or from a terminal:

   ```bash
   gh workflow run release.yml --ref main -f publish=false
   ```

   It also works on the release branch before it is merged (`--ref release-X.Y.Z`): the "commit is on main" check only applies to a real publish. It runs the CI gate, every release check and `npm publish --dry-run`, and prints the release notes it would use. A rehearsal does not exercise the npm login (OIDC), the tag or the GitHub release; only a real publish does.
4. **Create the trusted publisher on npm. Do this only now.** A new entry **expires if its first publish doesn't happen within 2 days**. Either route creates the same entry.

   From a terminal (needs npm ≥ 11.15 and an interactive `npm login` with 2FA; a token that bypasses 2FA does not work for `npm trust`):

   ```bash
   npm login
   ```

   ```bash
   npm trust github homebridge-trane-nexia --repo drewan50/homebridge-trane-nexia --file release.yml --allow-publish
   ```

   Add `--dry-run` to see what it would create first. `npm trust list homebridge-trane-nexia` shows the entry (it asks for 2FA in the browser, even for a read).

   Or on the website: npmjs.com → Packages → `homebridge-trane-nexia` → **Settings** → **Trusted publishing** → **GitHub Actions**:

   | Field | Value |
   |---|---|
   | Organization or user | `drewan50` |
   | Repository | `homebridge-trane-nexia` |
   | Workflow filename | `release.yml` (just the file name, with extension) |
   | Environment name | leave empty |
   | Allowed actions | tick **publish** (the workflow publishes directly). For a human approval step instead, leave publish unticked and see "Optional: stage-only" below |

   The workflow file name is part of the trust: don't rename `release.yml` without redoing this.
5. **Publish** (under "Each release", step 4), within the 2 days. That first successful publish validates the entry.
6. **Tighten things after the first successful automated release:**
   - **npm: Settings → Publishing access → "Require two-factor authentication and disallow tokens" (recommended).** It needs no re-release: it is a package setting about how future versions may be published and does not touch published ones. npm's docs say trusted publishers keep working (they use OIDC, not tokens). After it, a manual publish must be interactive with 2FA, which is what "Manual fallback" below does. Your own login and 2FA are required to change it, so an agent can't. The next release is the first proof; if its publish fails with an auth error, set it back and look.
   - **GitHub tag ruleset: done 2026-11-25** ("Protect release tags", target `refs/tags/v*`): released tags can't be **deleted or moved** (rules *deletion* and *update*, no bypass). Tag **creation** is deliberately not restricted: the Release workflow creates the tag as `github-actions[bot]`, and a creation rule would block it. To fix a wrongly created tag, disable the ruleset in Settings → Rules, fix it, and enable it again.
   - Optional human gate: create a GitHub *environment* (for example `npm-publish`) with you as a required reviewer, add `environment: npm-publish` to the `publish` job, and put the same name in the npm entry.

## Each release

### 1. Choose the version

| Change | Bump |
|---|---|
| Bug fix, diagnostics, internal/tooling | patch |
| New config option or new accessory | minor |
| Changed accessory identity (UUID seed, services, names), removed config key, dropped Node/Homebridge major | **major**: users lose rooms, scenes and automations in the Home app |

Decide with `CHANGELOG.md`'s `[Unreleased]` section in front of you. As of 2026-11-25 it holds fixes, diagnostics and tooling only, so the recommendation is **1.1.3 (patch)**. Node 18 and 20 stay supported.

### 2. Prepare the release commit (an agent can do this when you say go)

```bash
git switch -c release-X.Y.Z                 # off an up-to-date main
node scripts/release.js prepare X.Y.Z        # bumps package.json + package-lock.json, turns [Unreleased] into [X.Y.Z] - today
git diff                                     # only the version lines and the changelog heading should change
git commit -am "Release vX.Y.Z"
```

Then check locally, with a working Node (see `CLAUDE.md`):

```bash
npm ci && npm test && npm audit && npm pack --dry-run
node scripts/release.js check --tag vX.Y.Z   # the same check the workflow runs
```

- [ ] `npm pack --dry-run` lists only `CHANGELOG.md`, `LICENSE`, `README.md`, `bin/`, `config.schema.json`, `dist/*.js` and `package.json`. **Never** `nexia-credentials.json`, `*dump*.json`, `.claude/`, `test/`, source or `.map` files.
- [ ] Optional but wise for anything that touches the HomeKit mapping or the write path: `npm pack`, install the `.tgz` on the NAS (README, Method B), restart Homebridge, and watch the log and the Home app for a few polling cycles. A published version can't be taken back.

### 3. Merge

Open the PR, let CI go green on every Node in the matrix, merge to `main`, then `git switch main && git pull`.

### 4. Publish (you)

Any one of:
- **Actions → Release → Run workflow**, branch `main`, tick **publish** → Run. It creates the tag and the release itself; or
- the same from a terminal: `gh workflow run release.yml --ref main -f publish=true`; or
- `git tag vX.Y.Z && git push origin vX.Y.Z` on the release commit.

Watch the run. The `Publish` job's steps: decide mode → check the release (npm ≥ 11.5.1, tag = version, changelog section dated and non-empty, `[Unreleased]` empty, lockfile in sync, commit on `main`, tag not on another commit) → `npm ci` → `npm test` → skip publishing if the version is already on npm → `npm publish` → GitHub release.

### 5. Verify

npm takes a few minutes to serve a new version. Right after a green publish, `npm view` (and the registry itself) answers 404 for X.Y.Z while the "Publish to npm" log says "Your package is being processed and may take a few minutes to become available". That is normal (1.1.3 took a few minutes). Wait, then:

```bash
npm view homebridge-trane-nexia version dist-tags
```

```bash
npm view homebridge-trane-nexia@X.Y.Z dist.shasum dist.attestations --json
```

- [ ] `version` is X.Y.Z and `latest` points at it.
- [ ] `dist.shasum` equals the `shasum:` line in the workflow's "Publish to npm" step (npm serves the tarball CI built), and `dist.attestations` is present (provenance; the log also prints a Sigstore transparency-log line).
- [ ] The GitHub release `vX.Y.Z` exists with the changelog notes (Homebridge Verified requires a release with notes for every version), and the tag is on the release commit.
- [ ] In the Homebridge UI → Plugins, update the plugin on the NAS and check the log (`sudo hb-service logs`).
- [ ] Tell anyone waiting on a fix which version has it. Replies on GitHub are public posts and need your yes.

## If something goes wrong

| What you see | Likely cause and fix |
|---|---|
| Release check fails | It names the problem: wrong tag, `[Unreleased]` not empty, no dated changelog section, lockfile version out of sync, repository URL. Run `node scripts/release.js prepare` or fix by hand, merge, retry. |
| CI gate red on one Node | Fix on a branch, merge, publish again. Nothing was published: publishing only starts after CI is green. |
| `npm publish` fails with an auth, 404 or "trusted publisher" style error | The npm entry doesn't match this run: check owner, repository, workflow filename (`release.yml`) and that *Environment* is empty (or matches). The entry also expires 2 days after creation if never used: delete it and create a new one. |
| `npm view` says 404 for the new version right after a green publish | npm processes uploads asynchronously (step 5). Wait a few minutes. The "Publish to npm" step would be red if it had failed; its log shows `+ homebridge-trane-nexia@X.Y.Z`. |
| `npm publish` says the version exists | It was already published. Re-running the workflow is safe: it skips publishing and just (re)creates the GitHub release. |
| Publish worked but the GitHub release failed | Re-run the failed workflow run from the Actions page. |
| A bad version went out | A number is permanent. `npm dist-tag add homebridge-trane-nexia@<last good> latest` and `npm deprecate homebridge-trane-nexia@<bad> "reason, fixed in <new>"`, then release a fixed patch through this same flow. (`npm unpublish` is heavily restricted: docs.npmjs.com/policies/unpublish.) |

## Homebridge Verified

Status is current. The requirements (Homebridge `plugins` wiki, checked 2026-11-25) include: runs on every supported Node LTS (**22, 24 and 26**; CI covers them plus 18 and 20), dynamic platform, settings GUI (`config.schema.json`), no analytics, **a GitHub release with notes for every version**, no unhandled exceptions, nothing written outside the Homebridge storage directory. No action is needed per release beyond the GitHub release, which the workflow creates.

## Optional: stage-only (a human approves every publish)

npm can accept an automated upload but hold it until a maintainer approves it with 2FA. To use it: in the npm trusted-publisher entry leave *publish* unticked (staging is always allowed), and change the workflow's `npm publish` step to `npm stage publish`. Then approve with `npm stage list` / `npm stage approve <id>` or on npmjs.com → Staged Packages. It needs npm ≥ 11.15. The workflow's "already on npm?" check and release step would then also need to wait for the approval, so make that change deliberately.

## Manual fallback (no Actions)

Only if Actions or the trusted publisher is unavailable. You need Node ≥ 22.14, `npm login`, and then, from the merged release commit on `main`: `npm ci && npm test && npm publish` (npm asks for your 2FA code), followed by `git tag vX.Y.Z && git push origin vX.Y.Z` and `node scripts/release.js notes | gh release create vX.Y.Z --title vX.Y.Z --notes-file -`. A manual publish has no provenance.
