import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/set-denylist-secrets.sh', import.meta.url));
const AT = '@';
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

// Runs the helper with a stub "gh" that records its arguments and stdin.
function run(args) {
  const dir = mkdtempSync(join(tmpdir(), 'set-secrets-'));
  const log = join(dir, 'gh.log');
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho "ARGS $*" >> "${log.replace(/\\/g, '/')}"\necho "STDIN $(cat)" >> "${log.replace(/\\/g, '/')}"\n`);
  chmodSync(join(dir, 'gh'), 0o755);
  const files = Object.fromEntries(Object.entries(args.files).map(([k, v]) => {
    const p = join(dir, k);
    writeFileSync(p, v);
    return [k, p.replace(/\\/g, '/')];
  }));
  const r = spawnSync('sh', [SCRIPT.replace(/\\/g, '/'), 'example-org', ...args.argv.map(a => files[a] ?? a)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, HYGIENE_DENYLIST: '' },
  });
  return { code: r.status, err: r.stderr, gh: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

test('refuses a denylist without rules', { skip: !hasSh }, () => {
  const r = run({ files: { 'd.txt': '# only a comment\n\n' }, argv: ['d.txt'] });
  assert.equal(r.code, 2);
  assert.match(r.err, /has no rules/);
  assert.equal(r.gh, '', 'no secret is set');
});

test('refuses an invalid denylist', { skip: !hasSh }, () => {
  const r = run({ files: { 'd.txt': '([unclosed\n' }, argv: ['d.txt'] });
  assert.notEqual(r.code, 0);
  assert.equal(r.gh, '');
});

test('sets both copies of the denylist and the identity allowlist', { skip: !hasSh }, () => {
  const ids = `# maintainers\none${AT}example.com\ntwo${AT}example.com, three${AT}example.com\n`;
  const r = run({ files: { 'd.txt': 'acme-internal\n', 'ids.txt': ids }, argv: ['d.txt', 'ids.txt'] });
  assert.equal(r.code, 0, r.err);
  for (const app of ['actions', 'dependabot']) {
    assert.match(r.gh, new RegExp(`ARGS secret set HYGIENE_DENYLIST --org example-org --app ${app} --visibility all`));
    assert.match(r.gh, new RegExp(`ARGS secret set HYGIENE_ALLOWED_IDENTITIES --org example-org --app ${app} --visibility all`));
  }
  assert.match(r.gh, new RegExp(`STDIN one${AT}example\\.com,two${AT}example\\.com,three${AT}example\\.com`));
});
