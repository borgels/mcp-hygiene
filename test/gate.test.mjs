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
  dependabot = false, denylist = DENYLIST, allowedIdentities = '' }) {
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
    HYGIENE_DENYLIST: denylist, HYGIENE_ALLOWED_IDENTITIES: allowedIdentities,
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

const ORG_MAIL = `maintainer${AT}acme-internal.example`;

function authored(dir, files, msg, email = ORG_MAIL) {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  sh(dir, 'add', '-A');
  const r = spawnSync('git', ['-C', dir, 'commit', '-qm', msg], {
    env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email },
  });
  assert.equal(r.status, 0);
  return sh(dir, 'rev-parse', 'HEAD');
}

test('allowed identities: identity fields exempt from the denylist (case-insensitive)', () => {
  const { dir, base } = repo();
  const head = authored(dir, { 'b.txt': 'x\n' }, 'update');
  const without = gate({ dir, base, head });
  assert.equal(without.code, 1);
  assert.match(without.log, /commit-email:\d+ {2}internal-term #1/);
  const withList = gate({ dir, base, head, allowedIdentities: `other${AT}example.com, ${ORG_MAIL.toUpperCase()}` });
  assert.equal(withList.code, 0, withList.log);
  assert.match(withList.log, /identity allowlist: 1 commit address\(es\), 0 trailer line\(s\)/);
});

test('allowed identities: the same address in content and messages is still caught', () => {
  const { dir, base } = repo();
  const head = authored(dir, { 'c.txt': `contact ${ORG_MAIL}\n` }, `mail ${ORG_MAIL}`);
  const r = gate({ dir, base, head, allowedIdentities: ORG_MAIL });
  assert.equal(r.code, 1);
  assert.match(r.log, /c\.txt:1 {2}internal-term #1/);
  assert.match(r.log, /commit-[0-9a-f]{12}:1 {2}internal-term #1/);
  assert.ok(!/commit-email:/.test(r.log), 'identity field is exempt');
});

test('allowed identities still get the generic rules', () => {
  const { dir, base } = repo();
  const head = authored(dir, { 'b.txt': 'x\n' }, 'x', PERSONAL);
  const r = gate({ dir, base, head, allowedIdentities: PERSONAL });
  assert.equal(r.code, 1);
  assert.match(r.log, /commit-email-allowed:\d+ {2}email-address/);
});

test('allowed identities: sign-off and co-author trailers with the address are exempt', () => {
  const { dir, base } = repo();
  const msg = [
    'Update docs',
    '',
    `Signed-off-by: Maintainer <${ORG_MAIL}>`,
    `Co-authored-by: Maintainer <${ORG_MAIL.toUpperCase()}>`,
  ].join('\n');
  const head = authored(dir, { 'b.txt': 'x\n' }, msg);
  const without = gate({ dir, base, head });
  assert.equal(without.code, 1);
  assert.match(without.log, /commit-[0-9a-f]{12}:3 {2}internal-term #1/);
  const r = gate({ dir, base, head, allowedIdentities: ORG_MAIL });
  assert.equal(r.code, 0, r.log);
  assert.match(r.log, /1 commit address\(es\), 2 trailer line\(s\)/);
  // exempt trailer locations are listed, the lines themselves are not
  assert.match(r.log, /- commit-[0-9a-f]{12}:3 {2}trailer \(generic rules only\)/);
  assert.match(r.log, /- commit-[0-9a-f]{12}:4 {2}trailer \(generic rules only\)/);
  assert.ok(!r.log.includes(ORG_MAIL), 'trailer text is not printed');
});

test('allowed identities: trailer exemption cannot carry other text or addresses', () => {
  const { dir, base } = repo();
  const msg = [
    'Update',
    '',
    // second address riding along with the allowlisted one
    `Co-authored-by: X <other${AT}acme-internal.example> <${ORG_MAIL}>`,
    // indented, and a space before the colon
    `  Signed-off-by: acme-internal <${ORG_MAIL}>`,
    `Signed-off-by : acme-internal <${ORG_MAIL}>`,
    // long free text in the name part
    `Co-authored-by: ${'acme-internal notes '.repeat(6)}<${ORG_MAIL}>`,
    // control: a plain trailer with a non-ASCII name stays exempt
    `Co-authored-by: Søren Ærbø <${ORG_MAIL}>`,
  ].join('\n');
  const head = authored(dir, { 'b.txt': 'x\n' }, msg);
  const r = gate({ dir, base, head, allowedIdentities: ORG_MAIL });
  assert.equal(r.code, 1);
  for (const line of [3, 4, 5, 6]) assert.match(r.log, new RegExp(`commit-[0-9a-f]{12}:${line} {2}internal-term #1`));
  assert.match(r.log, /1 commit address\(es\), 1 trailer line\(s\)/);
  assert.match(r.log, /- commit-[0-9a-f]{12}:7 {2}trailer \(generic rules only\)/);
});

test('allowed identities: other lines, other trailers and other addresses are still checked', () => {
  const { dir, base } = repo();
  const msg = [
    `Mention ${ORG_MAIL} in the text`,
    '',
    `Reviewed-by: Maintainer <${ORG_MAIL}>`,
    `Signed-off-by: Someone <other${AT}acme-internal.example>`,
    `Co-authored-by: Maintainer <${ORG_MAIL}> acme-internal`,
    `Signed-off-by: Maintainer <${ORG_MAIL}>`,
  ].join('\n');
  const head = authored(dir, { 'b.txt': 'x\n' }, msg);
  const r = gate({ dir, base, head, allowedIdentities: ORG_MAIL });
  assert.equal(r.code, 1);
  for (const line of [1, 3, 4, 5]) assert.match(r.log, new RegExp(`commit-[0-9a-f]{12}:${line} {2}internal-term #1`));
  assert.ok(!/commit-[0-9a-f]{12}:6 {2}internal-term/.test(r.log), 'the allowlisted sign-off is exempt');
});

test('a denylist with only comments counts as missing', () => {
  const { dir, base } = repo();
  const head = commit(dir, { 'b.txt': 'hello\n' });
  const r = gate({ dir, base, head, denylist: '# placeholder\n\n' });
  assert.equal(r.code, 1);
  assert.match(r.log, /HYGIENE_DENYLIST org secret has no rules \(Actions secret\)/);
  const fork = gate({ dir, base, head, denylist: '# placeholder\n', fork: true });
  assert.equal(fork.code, 0, fork.log);
});

test('shallow checkout: only the history of base and head is fetched', () => {
  const src = repo();
  sh(src.dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const bad = commit(src.dir, { 'b.txt': 'acme-internal\n' });
  const head = commit(src.dir, { 'b.txt': 'clean\n' });
  const dir = mkdtempSync(join(tmpdir(), 'gate-shallow-'));
  const url = `file://${src.dir.replace(/\\/g, '/')}`;
  const cl = spawnSync('git', ['clone', '-q', '--depth', '1', '--no-local', url, dir], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(cl.status, 0, cl.stderr);
  assert.equal(sh(dir, 'rev-parse', '--is-shallow-repository'), 'true');
  const r = gate({ dir, base: src.base, head });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, new RegExp(`commit-${bad.slice(0, 12)}:b\\.txt:1 {2}internal-term #1`));
  assert.equal(sh(dir, 'rev-parse', '--is-shallow-repository'), 'false');
});

test('allowed identities: a trailer with a CRLF line ending stays exempt', () => {
  const { dir, base } = repo();
  writeFileSync(join(dir, 'b.txt'), 'x\n');
  sh(dir, 'add', '-A');
  const msg = ['Update', '', `Signed-off-by: Maintainer <${ORG_MAIL}>`, `Mention acme-internal`, ''].join('\r\n');
  const c = spawnSync('git', ['-C', dir, 'commit', '-q', '--cleanup=verbatim', '-m', msg], {
    env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_EMAIL: ORG_MAIL, GIT_COMMITTER_EMAIL: ORG_MAIL },
  });
  assert.equal(c.status, 0);
  const head = sh(dir, 'rev-parse', 'HEAD');
  assert.ok(sh(dir, 'log', '-1', '--format=%B', head).includes('\r'), 'message keeps CRLF');
  const r = gate({ dir, base, head, allowedIdentities: ORG_MAIL });
  assert.equal(r.code, 1);
  assert.match(r.log, /- commit-[0-9a-f]{12}:3 {2}trailer \(generic rules only\)/);
  assert.match(r.log, /commit-[0-9a-f]{12}:4 {2}internal-term #1/);
  assert.ok(!/commit-[0-9a-f]{12}:3 {2}internal-term/.test(r.log), 'CRLF trailer is exempt');
});
