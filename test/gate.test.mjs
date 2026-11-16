import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = fileURLToPath(new URL('../scripts/gate.mjs', import.meta.url));
const AT = '@';
const PERSONAL = `someone${AT}gmail.com`;
const DENYLIST = '\\bacme-internal\\b\n';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: `test${AT}example.com`,
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: `test${AT}example.com`,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
};

function sh(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-repo-'));
  sh(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'base');
  return { dir, base: sh(dir, 'rev-parse', 'HEAD') };
}

function commit(dir, files, msg = 'change') {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', msg);
  return sh(dir, 'rev-parse', 'HEAD');
}

function gate({ dir, base, head, title = 'Update', body = 'Neutral text.', headRef = 'feature/x', fork = false,
  dependabot = false, denylist = DENYLIST }) {
  const work = mkdtempSync(join(tmpdir(), 'gate-run-'));
  const eventPath = join(work, 'event.json');
  writeFileSync(eventPath, JSON.stringify({
    pull_request: {
      title, body,
      user: { login: dependabot ? 'dependabot[bot]' : 'someone' },
      base: { sha: base },
      head: { sha: head, ref: headRef, repo: { full_name: fork ? 'other/repo' : 'org/repo' } },
    },
  }));
  const envFile = join(work, 'github.env');
  writeFileSync(envFile, '');
  const env = {
    ...process.env, ...GIT_ENV,
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: 'org/repo',
    GITHUB_ACTOR: dependabot ? 'dependabot[bot]' : 'someone', GITHUB_HEAD_REF: headRef, GITHUB_ENV: envFile,
    HYGIENE_DENYLIST: denylist,
  };
  delete env.GITHUB_ACTIONS;
  const out = join(work, 'out');
  const c = spawnSync(process.execPath, [GATE, 'collect', dir, out], { encoding: 'utf8', env });
  assert.equal(c.status, 0, c.stderr);
  const s = spawnSync(process.execPath, [GATE, 'scan', out], { encoding: 'utf8', env });
  return { code: s.status, log: s.stdout + s.stderr, collect: c.stdout, githubEnv: readFileSync(envFile, 'utf8') };
}

test('clean pull request passes and exports the range', () => {
  const { dir, base } = repo();
  const head = commit(dir, { 'b.txt': 'hello\n' });
  const r = gate({ dir, base, head });
  assert.equal(r.code, 0, r.log);
  assert.match(r.log, /clean \(1 internal-term rules/);
  assert.match(r.githubEnv, new RegExp(`BASE_SHA=${base}\nHEAD_SHA=${head}`));
  assert.match(r.collect, /commits: 1/);
});

test('a term added in one commit and removed in the next is reported for that commit', () => {
  const { dir, base } = repo();
  const bad = commit(dir, { 'b.txt': 'host acme-internal\n' });
  const head = commit(dir, { 'b.txt': 'host <host>\n' });
  const r = gate({ dir, base, head });
  assert.equal(r.code, 1);
  assert.match(r.log, new RegExp(`commit-${bad.slice(0, 12)}:b\\.txt:1 {2}internal-term #1`));
});

test('content introduced by a merge commit itself is found (--remerge-diff)', () => {
  const { dir, base } = repo();
  sh(dir, 'checkout', '-q', '-b', 'side');
  commit(dir, { 'side.txt': 'side\n' });
  sh(dir, 'checkout', '-q', 'main');
  commit(dir, { 'main.txt': 'main\n' });
  sh(dir, 'merge', '-q', '--no-ff', '--no-commit', 'side');
  writeFileSync(join(dir, 'evil.txt'), 'acme-internal\n');
  sh(dir, 'add', 'evil.txt');
  sh(dir, 'commit', '-qm', 'merge');
  sh(dir, 'rm', '-q', 'evil.txt');
  sh(dir, 'commit', '-qm', 'cleanup');
  const r = gate({ dir, base, head: sh(dir, 'rev-parse', 'HEAD') });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /evil\.txt:1 {2}internal-term #1/);
});

test('a .gitattributes "-diff" in the change does not hide content', () => {
  const { dir, base } = repo();
  const head = commit(dir, { '.gitattributes': '*.md -diff\n', 'notes.md': `mail ${PERSONAL}\n` });
  const r = gate({ dir, base, head });
  assert.equal(r.code, 1);
  assert.match(r.log, /notes\.md:1 {2}email-address/);
});

test('title, body and branch name come from the event and are checked', () => {
  const { dir, base } = repo();
  const head = commit(dir, { 'b.txt': 'x\n' });
  const r = gate({ dir, base, head, title: 'acme-internal fix', body: `ping ${PERSONAL}`, headRef: 'fix/acme-internal' });
  assert.equal(r.code, 1);
  assert.match(r.log, /pr-title:1 {2}internal-term #1/);
  assert.match(r.log, /pr-body:1 {2}email-address/);
  assert.match(r.log, /head-ref:1 {2}internal-term #1/);
});

test('author e-mail is checked; author name gets generic rules only', () => {
  const { dir, base } = repo();
  writeFileSync(join(dir, 'b.txt'), 'x\n');
  sh(dir, 'add', '.');
  const r0 = spawnSync('git', ['-C', dir, 'commit', '-qm', 'x'], {
    env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_NAME: 'acme-internal', GIT_AUTHOR_EMAIL: PERSONAL },
  });
  assert.equal(r0.status, 0);
  const r = gate({ dir, base, head: sh(dir, 'rev-parse', 'HEAD') });
  assert.equal(r.code, 1);
  assert.match(r.log, /commit-email:\d+ {2}email-address/);
  assert.ok(!/commit-name/.test(r.log), 'names are not checked against the denylist');
});

test('missing denylist: same-repository pull request fails', () => {
  const { dir, base } = repo();
  const head = commit(dir, { 'b.txt': 'hello\n' });
  const r = gate({ dir, base, head, denylist: '' });
  assert.equal(r.code, 1);
  assert.match(r.log, /HYGIENE_DENYLIST org secret not configured \(Actions secret\)/);
});

test('missing denylist: Dependabot pull request fails (fail closed)', () => {
  const { dir, base } = repo();
  const head = commit(dir, { 'b.txt': 'hello\n' });
  const r = gate({ dir, base, head, denylist: '', dependabot: true });
  assert.equal(r.code, 1);
  assert.match(r.log, /not configured \(Dependabot secret\)/);
});

test('missing denylist: fork pull request runs generic rules only', () => {
  const { dir, base } = repo();
  const clean = gate({ dir, base, head: commit(dir, { 'b.txt': 'hello\n' }), denylist: '', fork: true });
  assert.equal(clean.code, 0, clean.log);
  assert.match(clean.log, /::notice::Pull request from a fork/);
  const bad = gate({ dir, base, head: commit(dir, { 'c.txt': `${PERSONAL}\n` }), denylist: '', fork: true });
  assert.equal(bad.code, 1);
});

test('a path with a space (TAB after the +++ header) is handled once and withheld', () => {
  const { dir, base } = repo();
  const head = commit(dir, { 'my acme-internal.md': `mail ${PERSONAL}\n` });
  const r = gate({ dir, base, head, denylist: 'acme-internal\\.md$' });
  assert.equal(r.code, 1);
  assert.match(r.log, /<path #1>:path {2}internal-term #1/);
  assert.match(r.log, /<path #1>:1 {2}email-address/);
  assert.ok(!/acme/.test(r.log), r.log);
  assert.ok(!/<path #2>/.test(r.log), 'path counted once');
});
