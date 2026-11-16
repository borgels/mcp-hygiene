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

test('new and renamed file paths are checked', () => {
  const d = [
    'diff --git a/docs/a.md b/docs/acme-internal.md',
    'similarity index 100%',
    'rename from docs/a.md',
    'rename to docs/acme-internal.md',
    '',
  ].join('\n');
  const r = run(['--diff', '-'], { input: d, denylist: DENYLIST });
  assert.equal(r.code, 1);
  assert.match(r.err, /internal-term #1/);
});

test('lockfile contents are skipped', () => {
  const d = diff([`"resolved": "${PERSONAL}"`]).replaceAll('src/file.js', 'package-lock.json');
  const r = run(['--diff', '-'], { input: d });
  assert.equal(r.code, 0, r.err);
});

test('local home paths are flagged, generic runner paths are not', () => {
  assert.equal(text('built in /home/runner/work/x').code, 0);
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
