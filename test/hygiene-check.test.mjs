import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/hygiene-check.mjs', import.meta.url));

// Sample values are assembled at runtime so this file does not itself trip the check.
const AT = '@';
const PERSONAL = `someone${AT}gmail.com`;
const PUBLIC_IP = ['93', '184', '215', '14'].join('.');
const DENYLIST = '\\bacme-internal\\b\ni secret-project-x\n# comment line\n';

function run(args, { input, denylist = '' } = {}) {
  const env = { ...process.env, HYGIENE_DENYLIST: denylist };
  delete env.HYGIENE_ALLOWED_EMAILS;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { input, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const text = (body, opts) => run(['--label', 'body', '--text', '-'], { input: body, ...opts });

function diff(added, { context = [] } = {}) {
  const lines = [...context.map(l => ` ${l}`), ...added.map(l => `+${l}`)];
  return [
    'diff --git a/src/file.js b/src/file.js',
    'index 0000000..1111111 100644',
    '--- a/src/file.js',
    '+++ b/src/file.js',
    `@@ -1,${context.length} +1,${lines.length} @@`,
    ...lines,
    '',
  ].join('\n');
}

test('clean text exits 0', () => {
  const r = text('A neutral sentence about the API.\nSee https://example.com/docs.', { denylist: DENYLIST });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /clean \(2 internal-term rules/);
});

test('personal mail address is flagged and masked', () => {
  const r = text(`contact ${PERSONAL} for access`);
  assert.equal(r.code, 1);
  assert.match(r.err, /body:1 {2}email-address/);
  assert.ok(!r.err.includes(PERSONAL), 'full address must not be printed');
});

test('documentation addresses and private IPs are allowed', () => {
  const r = text(`user${AT}example.com 10.0.0.1 192.168.1.20 192.0.2.10 noreply${AT}github.com`);
  assert.equal(r.code, 0, r.err);
});

test('public IP address is flagged', () => {
  const r = text(`server at ${PUBLIC_IP}`);
  assert.equal(r.code, 1);
  assert.match(r.err, /public-ip-address/);
});

test('denylist match reports rule number only, never the term', () => {
  const r = text('notes for the Secret-Project-X rollout and acme-internal hosts', { denylist: DENYLIST });
  assert.equal(r.code, 1);
  assert.match(r.err, /internal-term #1/);
  assert.match(r.err, /internal-term #2/);
  assert.ok(!/acme|secret-project/i.test(r.err + r.out), 'denylist terms must never be printed');
});

test('word boundaries in denylist patterns are honoured', () => {
  const r = text('acme-internalization is a different word', { denylist: DENYLIST });
  assert.equal(r.code, 0, r.err);
});

test('hygiene:allow marks a deliberate false positive', () => {
  const r = text(`maintainer: ${PERSONAL} hygiene:allow`);
  assert.equal(r.code, 0, r.err);
});

test('diff mode checks added lines only, with file and line number', () => {
  const d = [
    'diff --git a/a.md b/a.md',
    '--- a/a.md',
    '+++ b/a.md',
    '@@ -1,3 +1,3 @@',
    ' first',
    `-old ${PERSONAL}`,
    `+new acme-internal note`,
    ' third',
    '',
  ].join('\n');
  const r = run(['--diff', '-'], { input: d, denylist: DENYLIST });
  assert.equal(r.code, 1);
  assert.match(r.err, /a\.md:2 {2}internal-term #1/);
  assert.ok(!r.err.includes('email-address'), 'removed lines are not checked');
});

test('an added line starting with "++ " is content, not a file header', () => {
  const r = run(['--diff', '-'], { input: diff([`++ ${PERSONAL}`]) });
  assert.equal(r.code, 1);
  assert.match(r.err, /src\/file\.js:1 {2}email-address/);
});

test('new and renamed file paths are checked; matching paths are withheld', () => {
  const d = [
    'diff --git a/docs/a.md b/docs/acme-internal.md',
    'similarity index 100%',
    'rename from docs/a.md',
    'rename to docs/acme-internal.md',
    '',
  ].join('\n');
  const r = run(['--diff', '-'], { input: d, denylist: DENYLIST });
  assert.equal(r.code, 1);
  assert.match(r.err, /<path #1>:path {2}internal-term #1/);
  assert.ok(!/acme/i.test(r.err + r.out), 'withheld path must not be printed');
});

test('content lines of a withheld path do not print the path', () => {
  const d = diff([`mail ${PERSONAL}`]).replaceAll('src/file.js', 'docs/acme-internal.md');
  const r = run(['--diff', '-'], { input: d, denylist: DENYLIST });
  assert.equal(r.code, 1);
  assert.match(r.err, /<path #1>:1 {2}email-address/);
  assert.ok(!/acme/i.test(r.err + r.out));
});

test('lockfiles: generic rules skipped, denylist still applied', () => {
  const lock = s => diff([s]).replaceAll('src/file.js', 'package-lock.json');
  assert.equal(run(['--diff', '-'], { input: lock(`"resolved": "${PERSONAL}"`) }).code, 0);
  const r = run(['--diff', '-'], { input: lock('"resolved": "https://acme-internal/npm/x.tgz"'), denylist: DENYLIST });
  assert.equal(r.code, 1);
  assert.match(r.err, /internal-term #1/);
});

test('git log -p output: a term added then removed is still found, tagged with its commit', () => {
  const one = (sha, add, del) => [
    `commit ${sha}`,
    '',
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    `@@ -1,${del.length} +1,${add.length} @@`,
    ...del.map(l => `-${l}`),
    ...add.map(l => `+${l}`),
  ];
  const log = [...one('b'.repeat(40), ['host is <host>'], ['host is acme-internal']),
    ...one('a'.repeat(40), ['host is acme-internal'], [])].join('\n');
  const r = run(['--diff', '-'], { input: log, denylist: DENYLIST });
  assert.equal(r.code, 1);
  assert.match(r.err, /commit-aaaaaaaaaaaa:a\.txt:1 {2}internal-term #1/);
});

test('--paths reads name-status -z output, including binary and empty files', () => {
  const z = ['A', 'img/acme-internal.png', 'M', 'src/ok.js', 'D', 'old/acme-internal.txt',
    'R100', 'x.md', 'notes/secret-project-x.md', ''].join('\0');
  const r = run(['--paths', '-'], { input: z, denylist: DENYLIST });
  assert.equal(r.code, 1);
  assert.match(r.err, /<path #1>:path {2}internal-term #1/);
  assert.match(r.err, /<path #3>:path {2}internal-term #2/);
  assert.equal((r.err.match(/internal-term/g) ?? []).length, 2, 'deleted paths are not reported');
});

test('quoted (octal-escaped) paths are decoded', () => {
  const d = diff(['x']).replace('+++ b/src/file.js', '+++ "b/docs/s\\303\\270ren.md"');
  const r = run(['--diff', '-'], { input: d, denylist: 'søren' });
  assert.equal(r.code, 1);
  assert.match(r.err, /<path #1>:path/);
});

test('--rules generic skips the denylist for the inputs that follow', () => {
  const r = run(['--rules', 'generic', '--label', 'name', '--text', '-'], { input: 'acme-internal', denylist: DENYLIST });
  assert.equal(r.code, 0, r.err);
});

test('hygiene:allow hits are listed, private keys cannot be allowed', () => {
  const r = text(`x ${PERSONAL} hygiene:allow`);
  assert.equal(r.code, 0);
  assert.match(r.err, /1 hit\(s\) skipped by hygiene:allow:\n {2}body:1 {2}email-address/);
  const key = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  assert.equal(text(`${key} hygiene:allow`).code, 1);
});

test('version-like dotted numbers are not IP addresses', () => {
  const v = (...p) => p.join('.');
  const r = text(`UA Chrome/${v(120, 1, 2, 3)} and ${v(1, 0, 0, 0)} and ${v(120, 0, 0, 0)} resolver ${v(1, 0, 0, 1)}`);
  assert.equal(r.code, 0, r.err);
  assert.equal(text(`url http://${PUBLIC_IP}/x`).code, 1);
});

test('mail.<company> addresses are not treated as personal mailboxes', () => {
  assert.equal(text(`support${AT}mail.company-name.com`).code, 0);
});

test('--allow-emails-file and HYGIENE_ALLOWED_EMAILS allow listed addresses', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const f = join(mkdtempSync(join(tmpdir(), 'hc-')), 'allow.txt');
  writeFileSync(f, `# maintainers\n${PERSONAL}\n`);
  assert.equal(run(['--allow-emails-file', f, '--text', '-'], { input: PERSONAL }).code, 0);
});

test('long unbroken tokens do not cause super-linear matching', () => {
  const t0 = Date.now();
  const r = text(`${'a'.repeat(400_000)} ${'b.'.repeat(100_000)}`);
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('a denylist pattern matching the empty string is rejected', () => {
  const r = text('anything', { denylist: 'foo|' });
  assert.equal(r.code, 2);
  assert.match(r.err, /denylist line 1 matches the empty string/);
});

test('no output cap: every finding is listed', () => {
  const r = text(Array.from({ length: 250 }, () => `x ${PERSONAL}`).join('\n'));
  assert.equal(r.code, 1);
  assert.match(r.err, /250 finding\(s\)/);
  assert.match(r.err, /body:250 {2}email-address/);
});

test('local home paths are flagged, generic runner paths are not', () => {
  assert.equal(text('built in /home/runner/work/x').code, 0);
  assert.equal(text(`WORKDIR ${['', 'home', 'appuser', 'src'].join('/')}`).code, 0);
  assert.equal(text(['C:', 'Users', 'Public', 'Documents'].join('\\')).code, 0);
  const r = text(`log at ${['', 'Users', 'jdoe', 'projects'].join('/')}/x`);
  assert.equal(r.code, 1);
  assert.match(r.err, /local-home-path/);
});

test('invalid denylist regex is a configuration error (exit 2)', () => {
  const r = text('anything', { denylist: '([unclosed' });
  assert.equal(r.code, 2);
  assert.match(r.err, /denylist line 1/);
});

test('unreadable input is an error (exit 2), not a finding', () => {
  const r = run(['--label', 'x', '--text', 'does-not-exist.txt']);
  assert.equal(r.code, 2);
});
