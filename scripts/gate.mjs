#!/usr/bin/env node
// Pull request / merge queue gate around hygiene-check.mjs.
//
//   gate.mjs collect REPO_DIR OUT_DIR   (no secrets needed)
//     Reads the event from GITHUB_EVENT_NAME / GITHUB_EVENT_PATH, resolves the
//     commit range and writes everything to check into OUT_DIR: net diff and
//     per-commit diffs (merge commits via --remerge-diff), changed paths,
//     commit messages, author/committer identities, branch name, PR title and
//     body. PR text is read from the event file, never from the environment,
//     so it does not appear in the step's logged env block.
//     Appends BASE_SHA and HEAD_SHA to GITHUB_ENV when set. A shallow checkout
//     is deepened by fetching the history of the base and head commits only.
//
//   gate.mjs scan OUT_DIR               (needs HYGIENE_DENYLIST)
//     Runs hygiene-check.mjs on the collected files. Without a denylist that
//     has at least one rule, pull requests from forks (which never receive
//     secrets) get the generic rules only; every other run fails.
//     HYGIENE_ALLOWED_IDENTITIES (optional; exact e-mail addresses separated
//     by commas or whitespace, case-insensitive): these addresses are checked
//     with the generic rules only in the commit author/committer fields and in
//     "Signed-off-by:" / "Co-authored-by:" trailer lines that carry them. The
//     same address anywhere else (file content, other message lines, PR text)
//     is still checked with every rule.
//
// Exit codes: 0 clean, 1 findings or missing denylist, 2 error.

import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(msg, code = 2) {
  console.error(`gate: ${msg}`);
  process.exit(code);
}

if (Number(process.versions.node.split('.')[0]) < 20) fail('Node 20+ required');

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'collect' && rest.length === 2) collect(resolve(rest[0]), resolve(rest[1]));
else if (cmd === 'scan' && rest.length === 1) scan(resolve(rest[0]));
else fail('usage: gate.mjs collect REPO_DIR OUT_DIR | gate.mjs scan OUT_DIR');

function git(repo, args, { out, allowFail = false } = {}) {
  const fd = out ? openSync(out, 'w') : undefined;
  try {
    const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
      encoding: 'utf8',
      maxBuffer: 256 << 20,
      stdio: ['ignore', fd ?? 'pipe', 'pipe'],
    });
    if (r.status !== 0 && !allowFail) fail(`git ${args[0]} failed (${r.status ?? r.error?.code})`);
    return r.status === 0 ? (r.stdout ?? '') : null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function collect(repo, out) {
  const event = process.env.GITHUB_EVENT_NAME;
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? fail('GITHUB_EVENT_PATH not set'), 'utf8'));
  let base;
  let head;
  let fork = false;
  let dependabot = false;
  let headRef;
  const texts = [];
  if (event === 'pull_request') {
    const pr = payload.pull_request;
    base = pr.base.sha;
    head = pr.head.sha;
    fork = pr.head.repo?.full_name !== process.env.GITHUB_REPOSITORY;
    dependabot = process.env.GITHUB_ACTOR === 'dependabot[bot]' && pr.user?.login === 'dependabot[bot]';
    headRef = process.env.GITHUB_HEAD_REF || pr.head.ref;
    texts.push(['pr-title', pr.title ?? ''], ['pr-body', pr.body ?? '']);
  } else if (event === 'merge_group') {
    base = payload.merge_group.base_sha;
    head = payload.merge_group.head_sha;
    headRef = payload.merge_group.head_ref;
  } else {
    fail(`unsupported event ${event}`);
  }
  for (const sha of [base, head]) if (!/^[0-9a-f]{40}$/.test(sha ?? '')) fail('event has no commit range');
  if (git(repo, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    // shallow checkout: fetch the history of these two commits only (no branch list)
    git(repo, ['fetch', '--no-tags', '--quiet', '--unshallow', 'origin', base, head]);
  } else if (git(repo, ['cat-file', '-e', `${base}^{commit}`], { allowFail: true }) === null) {
    git(repo, ['fetch', '--no-tags', '--quiet', 'origin', base]);
  }
  git(repo, ['cat-file', '-e', `${head}^{commit}`]);

  mkdirSync(join(out, 'msg'), { recursive: true });
  const f = name => join(out, name);
  const range = `${base}..${head}`;
  const diffOpts = ['--text', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames'];
  // net change, then every commit: a value added and removed later is still found;
  // --remerge-diff shows what a merge commit itself introduced
  git(repo, ['diff', ...diffOpts, `${base}...${head}`], { out: f('net.diff') });
  git(repo, ['log', '-p', ...diffOpts, '--remerge-diff', '--format=commit %H', range], { out: f('commits.diff') });
  // all changed paths, including binary, empty and mode-only changes
  git(repo, ['diff', '--name-status', '-z', '--find-renames', `${base}...${head}`], { out: f('net.paths') });
  git(repo, ['log', '--name-status', '-z', '--find-renames', '--format=', range], { out: f('commits.paths') });
  const uniq = s => [...new Set(s.split('\n').filter(Boolean))].join('\n');
  writeFileSync(f('identity-emails.txt'), uniq(git(repo, ['log', '--format=%ae%n%ce', range])));
  writeFileSync(f('identity-names.txt'), uniq(git(repo, ['log', '--format=%an%n%cn', range])));
  writeFileSync(f('head-ref.txt'), `${headRef ?? ''}\n`);

  const args = ['--paths', f('net.paths'), '--paths', f('commits.paths'), '--diff', f('net.diff'), '--diff', f('commits.diff'),
    '--label', 'head-ref', '--text', f('head-ref.txt'), '--label', 'commit-email', '--text', f('identity-emails.txt')];
  const shas = git(repo, ['rev-list', range]).split('\n').filter(Boolean);
  const messages = [];
  for (const sha of shas) {
    const file = join(out, 'msg', `${sha}.txt`);
    const label = `commit-${sha.slice(0, 12)}`;
    git(repo, ['log', '-1', '--format=%B', sha], { out: file });
    args.push('--label', label, '--text', file);
    messages.push({ file, label });
  }
  for (const [label, text] of texts) {
    writeFileSync(f(`${label}.txt`), `${text}\n`);
    args.push('--label', label, '--text', f(`${label}.txt`));
  }
  // names: generic rules only (a maintainer's own name may be on the denylist)
  args.push('--rules', 'generic', '--label', 'commit-name', '--text', f('identity-names.txt'));

  writeFileSync(f('args.json'), JSON.stringify(args));
  writeFileSync(f('meta.json'), JSON.stringify({ event, base, head, fork, dependabot, messages }));
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `BASE_SHA=${base}\nHEAD_SHA=${head}\n`);
  console.log(`Range ${base}..${head} (fork: ${fork}, dependabot: ${dependabot}), commits: ${shas.length}`);
}

function scan(out) {
  const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'));
  const args = JSON.parse(readFileSync(join(out, 'args.json'), 'utf8'));
  // a secret that holds only comments or a placeholder is as good as none
  const rules = internalRuleCount(out);
  const configured = rules > 0;
  if (!configured && meta.fork) {
    console.log('::notice::Pull request from a fork: secrets are not available, running generic checks only.');
  }
  applyIdentityAllowlist(out, args, meta.messages ?? []);
  const r = spawnSync(process.execPath, [join(HERE, 'hygiene-check.mjs'), ...args], { stdio: 'inherit', env: process.env });
  if (r.status === null) fail(`scanner did not run (${r.error?.code ?? r.signal})`);
  if (!configured && !meta.fork) {
    const which = meta.dependabot ? 'Dependabot' : 'Actions';
    const what = (process.env.HYGIENE_DENYLIST ?? '').trim() ? 'has no rules' : 'not configured';
    console.log(`::error::HYGIENE_DENYLIST org secret ${what} (${which} secret)`);
    process.exit(r.status === 0 ? 1 : r.status);
  }
  process.exit(r.status);
}

function internalRuleCount(out) {
  const empty = join(out, 'empty.txt');
  writeFileSync(empty, '');
  const r = spawnSync(process.execPath, [join(HERE, 'hygiene-check.mjs'), '--text', empty], { encoding: 'utf8', env: process.env });
  if (r.status === 2) {
    process.stderr.write(r.stderr); // configuration error: line number only, never the pattern
    process.exit(2);
  }
  const m = /clean \((\d+) internal-term rules/.exec(r.stdout ?? '');
  if (!m) fail('could not read the denylist rule count');
  return Number(m[1]);
}

// Allowlisted addresses get the generic rules only in the author/committer
// fields and in sign-off / co-author trailer lines that carry them.
function applyIdentityAllowlist(out, args, messages) {
  const TRAILER = /^\s*(?:signed-off-by|co-authored-by)\s*:.*<([^<>\s]+)>\s*$/i;
  const allowed = new Set((process.env.HYGIENE_ALLOWED_IDENTITIES ?? '')
    .split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) return;
  const isAllowed = a => allowed.has(a.trim().toLowerCase());

  const file = join(out, 'identity-emails.txt');
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  writeFileSync(file, lines.filter(l => !isAllowed(l)).join('\n'));
  const exempt = lines.filter(isAllowed);
  if (exempt.length) {
    const exemptFile = join(out, 'identity-emails-allowed.txt');
    writeFileSync(exemptFile, exempt.join('\n'));
    args.push('--rules', 'generic', '--label', 'commit-email-allowed', '--text', exemptFile);
  }

  let trailers = 0;
  for (const { file: msgFile, label } of messages) {
    const msg = readFileSync(msgFile, 'utf8').split('\n');
    // keep line numbers: the trailer line is blanked in the all-rules copy and
    // kept at the same position in a generic-rules copy
    const generic = msg.map(l => (TRAILER.test(l) && isAllowed(TRAILER.exec(l)[1]) ? l : ''));
    if (!generic.some(Boolean)) continue;
    trailers += generic.filter(Boolean).length;
    writeFileSync(msgFile, msg.map((l, i) => (generic[i] ? '' : l)).join('\n'));
    const trailerFile = `${msgFile}.trailers`;
    writeFileSync(trailerFile, generic.join('\n'));
    args.push('--rules', 'generic', '--label', label, '--text', trailerFile);
  }
  console.log(`identity allowlist: ${exempt.length} commit address(es), ${trailers} trailer line(s) with generic rules only`);
}
