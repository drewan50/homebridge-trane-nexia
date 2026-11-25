'use strict';
// The release helper (scripts/release.js): what it refuses to publish, and how it prepares a release.
const test = require('node:test');
const assert = require('node:assert/strict');
const { changelogSections, releaseNotes, check, prepareChangelog, bumpVersion } = require('../scripts/release');

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

## [1.2.0] - 2026-12-01

### Fixed

- Something fixed.

## [1.1.2] - 2026-07-04

### Fixed

- Older fix.
`;
const pkg = { name: 'homebridge-trane-nexia', version: '1.2.0', repository: { type: 'git', url: 'git+https://github.com/drewan50/homebridge-trane-nexia.git' } };
const lock = { name: 'homebridge-trane-nexia', version: '1.2.0', packages: { '': { name: 'homebridge-trane-nexia', version: '1.2.0' }, 'node_modules/x': { version: '9.9.9' } } };
const ok = { pkg, lock, changelog: CHANGELOG };

test('a consistent repo passes, with or without a tag', () => {
  assert.deepEqual(check(ok), []);
  assert.deepEqual(check({ ...ok, tag: 'v1.2.0' }), []);
});

test('the tag must be exactly v<package version>', () => {
  assert.match(check({ ...ok, tag: 'v1.2.1' }).join('\n'), /does not match package\.json version/);
  assert.match(check({ ...ok, tag: '1.2.0' }).join('\n'), /does not match/);
});

test('only plain X.Y.Z versions can be released', () => {
  for (const v of ['1.2.0-beta.1', '1.2', 'v1.2.0', '']) {
    assert.match(check({ ...ok, pkg: { ...pkg, version: v } }).join('\n'), /not a plain X\.Y\.Z/, v);
  }
});

test('the lockfile must carry the same version', () => {
  const stale = { ...lock, packages: { ...lock.packages, '': { ...lock.packages[''], version: '1.1.2' } } };
  assert.match(check({ ...ok, lock: stale }).join('\n'), /package-lock\.json version/);
});

test('the repository URL must match the publishing repo (npm checks it)', () => {
  assert.match(check({ ...ok, pkg: { ...pkg, repository: { url: 'git+https://github.com/someone/else.git' } } }).join('\n'), /repository\.url/);
  assert.match(check({ ...ok, pkg: { ...pkg, repository: undefined } }).join('\n'), /repository\.url/);
});

test('the changelog needs a dated, non-empty section for the version, and nothing left in Unreleased', () => {
  assert.match(check({ ...ok, changelog: CHANGELOG.replace('## [1.2.0] - 2026-12-01', '## [1.1.9] - 2026-12-01') }).join('\n'), /no "## \[1\.2\.0\]/);
  assert.match(check({ ...ok, changelog: CHANGELOG.replace('## [1.2.0] - 2026-12-01', '## [1.2.0]') }).join('\n'), /needs a date/);
  assert.match(check({ ...ok, changelog: CHANGELOG.replace('### Fixed\n\n- Something fixed.\n', '') }).join('\n'), /is empty/);
  assert.match(check({ ...ok, changelog: CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- Forgotten entry.\n') }).join('\n'), /\[Unreleased\] still has entries/);
});

test('notes: the version\'s own section without its heading, never the neighbours', () => {
  assert.equal(releaseNotes(CHANGELOG, '1.2.0'), '### Fixed\n\n- Something fixed.');
  assert.equal(releaseNotes(CHANGELOG, '1.1.2'), '### Fixed\n\n- Older fix.', 'the last section too');
  assert.throws(() => releaseNotes(CHANGELOG, '9.9.9'), /no "## \[9\.9\.9\]"/);
});

test('sections are found by heading', () => {
  assert.deepEqual(changelogSections(CHANGELOG).map(s => s.version), ['Unreleased', '1.2.0', '1.1.2']);
});

test('prepare: Unreleased becomes the new version and a fresh empty Unreleased is left on top', () => {
  const unreleased = CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n\n- New thing.\n');
  const out = prepareChangelog(unreleased, '1.3.0', '2027-01-02');
  assert.match(out, /^## \[Unreleased\]\n\n## \[1\.3\.0\] - 2027-01-02\n\n### Fixed\n\n- New thing\./m);
  assert.equal(releaseNotes(out, '1.3.0'), '### Fixed\n\n- New thing.');
  assert.equal(changelogSections(out).find(s => s.version === 'Unreleased').body, '');
  assert.deepEqual(check({ pkg: { ...pkg, version: '1.3.0' }, lock: bumpVersion(pkg, lock, '1.3.0').lock, changelog: out }), []);
});

test('prepare refuses nothing-to-release, a duplicate version, or a missing Unreleased section', () => {
  assert.throws(() => prepareChangelog(CHANGELOG, '1.3.0', '2027-01-02'), /nothing to release/);
  const unreleased = CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n- x\n');
  assert.throws(() => prepareChangelog(unreleased, '1.2.0', '2027-01-02'), /already has a section for 1\.2\.0/);
  assert.throws(() => prepareChangelog('# Changelog\n\n## [1.0.0] - 2026-01-01\n\n- x\n', '1.1.0', '2027-01-02'), /no "## \[Unreleased\]"/);
});

test('bumpVersion changes only the version fields', () => {
  const next = bumpVersion(pkg, lock, '1.3.0');
  assert.equal(next.pkg.version, '1.3.0');
  assert.equal(next.lock.version, '1.3.0');
  assert.equal(next.lock.packages[''].version, '1.3.0');
  assert.equal(next.lock.packages['node_modules/x'].version, '9.9.9', 'dependency versions untouched');
  assert.equal(pkg.version, '1.2.0', 'inputs not mutated');
});
