#!/usr/bin/env node
/* Release helper, used by the Release workflow and by people.
 *
 *   node scripts/release.js prepare <X.Y.Z>        bump package.json + package-lock.json, and turn CHANGELOG's
 *                                                  [Unreleased] section into [X.Y.Z] - today (run on a release branch)
 *   node scripts/release.js check [--tag vX.Y.Z]   verify the repo is ready to publish; exit 1 with the reasons if not
 *   node scripts/release.js notes [<X.Y.Z>]        print that version's CHANGELOG section (the GitHub release notes)
 *
 * Plain Node, no dependencies. The logic is in exported functions so test/release.test.js can cover it. */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO_PATH = 'drewan50/homebridge-trane-nexia';
const SEMVER = /^\d+\.\d+\.\d+$/; // a release is exactly X.Y.Z; pre-releases are not published from here

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Splits CHANGELOG.md into { heading, version, body } sections at each "## [" line. */
function changelogSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = /^## \[([^\]]+)\](.*)$/.exec(line);
    if (m) {
      current = { heading: line, version: m[1], rest: m[2], bodyLines: [] };
      sections.push(current);
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  return sections.map(s => ({ heading: s.heading, version: s.version, rest: s.rest, body: s.bodyLines.join('\n').trim() }));
}

/** The text of one version's section, without its heading. Throws if there is none or it is empty. */
function releaseNotes(changelog, version) {
  const section = changelogSections(changelog).find(s => s.version === version);
  if (!section) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  if (!section.body) throw new Error(`The CHANGELOG.md section for ${version} is empty`);
  return section.body;
}

/** Problems that would make publishing wrong. An empty array means ready. */
function check({ pkg, lock, changelog, tag }) {
  const errors = [];
  const version = pkg.version;
  if (!SEMVER.test(String(version))) errors.push(`package.json version "${version}" is not a plain X.Y.Z release version`);
  if (tag !== undefined && tag !== `v${version}`) errors.push(`tag "${tag}" does not match package.json version (expected "v${version}")`);

  if (lock) {
    const lockVersions = [lock.version, lock.packages && lock.packages[''] && lock.packages[''].version];
    if (lockVersions.some(v => v !== version)) errors.push(`package-lock.json version (${lockVersions.join(' / ')}) does not match package.json (${version}); run "npm install --package-lock-only" or use "prepare"`);
  }

  const repoUrl = String((pkg.repository && pkg.repository.url) || '');
  if (!repoUrl.includes(`github.com/${REPO_PATH}`)) {
    errors.push(`package.json repository.url must point at github.com/${REPO_PATH} (npm checks it against the publishing repository); it is "${repoUrl}"`);
  }

  const sections = changelogSections(changelog);
  const mine = sections.find(s => s.version === version);
  if (!mine) {
    errors.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section; run "prepare ${version}"`);
  } else {
    if (!/^ - \d{4}-\d{2}-\d{2}\s*$/.test(mine.rest)) errors.push(`the CHANGELOG.md heading for ${version} needs a date: "## [${version}] - YYYY-MM-DD"`);
    if (!mine.body) errors.push(`the CHANGELOG.md section for ${version} is empty (it becomes the GitHub release notes)`);
  }
  const unreleased = sections.find(s => s.version.toLowerCase() === 'unreleased');
  if (unreleased && unreleased.body) errors.push('CHANGELOG.md [Unreleased] still has entries: move them under this version before releasing');
  return errors;
}

/** Turns "## [Unreleased]" into "## [X.Y.Z] - date" and puts a fresh empty [Unreleased] above it. */
function prepareChangelog(changelog, version, date) {
  const sections = changelogSections(changelog);
  const unreleased = sections.find(s => s.version.toLowerCase() === 'unreleased');
  if (!unreleased) throw new Error('CHANGELOG.md has no "## [Unreleased]" section to release');
  if (!unreleased.body) throw new Error('CHANGELOG.md [Unreleased] is empty: there is nothing to release');
  if (sections.some(s => s.version === version)) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  const heading = new RegExp(`^## \\[${escapeRegExp(unreleased.version)}\\].*$`, 'm');
  return changelog.replace(heading, `## [Unreleased]\n\n## [${version}] - ${date}`);
}

/** package.json and package-lock.json with only the version fields changed. */
function bumpVersion(pkg, lock, version) {
  const next = { ...pkg, version };
  const nextLock = lock && { ...lock, version, packages: lock.packages && { ...lock.packages, '': { ...lock.packages[''], version } } };
  return { pkg: next, lock: nextLock };
}

function readJson(file) { return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(path.join(ROOT, file), JSON.stringify(value, null, 2) + '\n'); }
function readText(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }

function fail(messages) {
  const onActions = process.env.GITHUB_ACTIONS === 'true';
  for (const m of [].concat(messages)) console.error(onActions ? `::error::${m}` : `error: ${m}`);
  process.exit(1);
}

function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'check') {
    const tagAt = args.indexOf('--tag');
    const tag = tagAt >= 0 ? args[tagAt + 1] : undefined;
    const errors = check({ pkg: readJson('package.json'), lock: readJson('package-lock.json'), changelog: readText('CHANGELOG.md'), tag });
    if (errors.length) fail(errors);
    console.log(`release check passed: v${readJson('package.json').version}`);
  } else if (cmd === 'notes') {
    const version = args[0] || readJson('package.json').version;
    try { process.stdout.write(releaseNotes(readText('CHANGELOG.md'), version) + '\n'); } catch (e) { fail(e.message); }
  } else if (cmd === 'prepare') {
    const version = args[0];
    if (!version || !SEMVER.test(version)) fail('usage: node scripts/release.js prepare <X.Y.Z>');
    try {
      const changelog = prepareChangelog(readText('CHANGELOG.md'), version, new Date().toISOString().slice(0, 10));
      const { pkg, lock } = bumpVersion(readJson('package.json'), readJson('package-lock.json'), version);
      fs.writeFileSync(path.join(ROOT, 'CHANGELOG.md'), changelog);
      writeJson('package.json', pkg);
      writeJson('package-lock.json', lock);
    } catch (e) { fail(e.message); }
    console.log(`prepared ${version}: CHANGELOG.md, package.json and package-lock.json updated. Review "git diff", then commit "Release v${version}".`);
  } else {
    console.error('usage: node scripts/release.js prepare <X.Y.Z> | check [--tag vX.Y.Z] | notes [X.Y.Z]');
    process.exit(2);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { changelogSections, releaseNotes, check, prepareChangelog, bumpVersion, SEMVER };
