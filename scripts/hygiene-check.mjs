#!/usr/bin/env node
// Public-text hygiene check: finds personal data, private network details and
// organisation-specific internal terms in text that is about to be published
// (added lines of a diff, commit messages, file paths, PR/issue text).
//
// Usage:
//   hygiene-check.mjs [--denylist FILE] [--allow-emails-file FILE]
//                     [--rules all|generic|internal] [--label NAME]
//                     (--diff FILE|- | --text FILE|- | --paths FILE|-)...
//
//   --diff   unified diff or `git log -p` output; only added lines are checked.
//            Lines "commit <sha>" between files tag findings with the commit.
//   --text   plain text; every line is checked. --label names it in output.
//   --paths  `git diff --name-status -z` / `git log --name-status -z` output;
//            added, modified, renamed and copied paths are checked.
//   --rules  rule set for the inputs that follow: all (default), generic
//            (public rules only) or internal (denylist only).
//
// Organisation-specific patterns come from --denylist FILE or the
// HYGIENE_DENYLIST environment variable (never commit them to a public repo).
// Denylist format: one regular expression per line; a leading "i " makes it
// case-insensitive; blank lines and lines starting with "#" are ignored.
// Text matched by a denylist pattern is never printed: findings show the rule
// number only, and a path that matches is replaced by "<path #N>".
//
// A line containing "hygiene:allow" is skipped by every rule except
// private-key; skipped hits are listed (location and rule only).
// Lockfiles are checked with denylist rules only.
//
// Exit codes: 0 clean, 1 findings, 2 usage/config error.

import { readFileSync } from 'node:fs';

function usage(msg) {
  if (msg) console.error(`hygiene-check: ${msg}`);
  console.error('usage: hygiene-check.mjs [--denylist FILE] [--allow-emails-file FILE] [--rules all|generic|internal] [--label NAME] (--diff|--text|--paths FILE|-)...');
  process.exit(2);
}

function read(src) {
  try {
    return src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8');
  } catch (e) {
    // an unreadable input must not look like "findings" (exit 1)
    console.error(`hygiene-check: cannot read ${src === '-' ? 'stdin' : src} (${e.code ?? 'error'})`);
    process.exit(2);
  }
}

const SCOPES = {
  all: { generic: true, internal: true },
  generic: { generic: true, internal: false },
  internal: { generic: false, internal: true },
};

const args = process.argv.slice(2);
const inputs = [];
let denylistFile;
let allowEmailsFile;
let label = 'text';
let scope = SCOPES.all;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  const next = () => {
    const v = args[++i];
    if (v === undefined) usage(`${a} needs a value`);
    return v;
  };
  if (a === '--diff') inputs.push({ kind: 'diff', src: next(), scope });
  else if (a === '--text') inputs.push({ kind: 'text', src: next(), label, scope });
  else if (a === '--paths') inputs.push({ kind: 'paths', src: next(), scope });
  else if (a === '--label') label = next();
  else if (a === '--rules') {
    const v = next();
    if (!SCOPES[v]) usage('--rules must be all, generic or internal');
    scope = SCOPES[v];
  } else if (a === '--denylist') denylistFile = next();
  else if (a === '--allow-emails-file') allowEmailsFile = next();
  else if (a === '-h' || a === '--help') usage();
  else usage(`unknown argument ${a}`);
}
if (inputs.length === 0) usage('nothing to check');

// ---- organisation denylist (private) ----
const denyRules = [];
{
  let raw = process.env.HYGIENE_DENYLIST ?? '';
  if (denylistFile) raw += `\n${read(denylistFile)}`;
  let n = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    n += 1;
    const ci = t.startsWith('i ');
    const src = ci ? t.slice(2).trim() : t;
    let re;
    try {
      re = new RegExp(src, ci ? 'giu' : 'gu');
      re.test('x'); // force compilation now; never echo the pattern
    } catch {
      console.error(`hygiene-check: denylist line ${n} is not a valid regular expression`);
      process.exit(2);
    }
    re.lastIndex = 0;
    if (re.test('')) {
      console.error(`hygiene-check: denylist line ${n} matches the empty string`);
      process.exit(2);
    }
    denyRules.push({ id: `internal-term #${n}`, re, secret: true });
  }
}

// ---- generic rules (public) ----
const ALLOWED_EMAIL = [
  /@example\.(com|org|net)$/i,
  /@[a-z0-9.-]+\.example$/i,
  /@(test|invalid|localhost)$/i,
  /\.(test|invalid|localhost|example)$/i,
  /noreply/i,
  /^git@github\.com$/i,
  /^security@/i,
];
const EXTRA_ALLOWED_EMAIL = [
  ...(process.env.HYGIENE_ALLOWED_EMAILS ?? '').split(/[\s,]+/),
  ...(allowEmailsFile ? read(allowEmailsFile).split(/\r?\n/).map(l => l.replace(/#.*/, '')) : []),
]
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Organisation domains are covered by the private denylist; generically we only
// flag addresses at public mail providers, which are almost always personal.
// The provider must be followed by a public suffix only (gmail.com, live.co.uk),
// so mail.<company>.<tld> is not mistaken for a personal mailbox.
const PERSONAL_MAIL = /@(gmail|googlemail|hotmail|outlook|live|msn|icloud|me|mac|yahoo|ymail|aol|proton|protonmail|pm|gmx|web|mail|yandex|zoho|fastmail|hey|tutanota|jubii|tdcadsl|stofanet|mail\.tele|privat)\.[a-z]{2,3}(\.[a-z]{2})?$/i;
function emailFinding(m) {
  const addr = m.toLowerCase();
  if (EXTRA_ALLOWED_EMAIL.includes(addr)) return false;
  if (ALLOWED_EMAIL.some(r => r.test(addr))) return false;
  return PERSONAL_MAIL.test(addr);
}

const PUBLIC_EXAMPLE_IPS = new Set([
  '1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112', // hygiene:allow
  '208.67.222.222', '208.67.220.220', // hygiene:allow
]);
function ipFinding(m, line, index) {
  const p = m.split('.').map(Number);
  if (p.some(x => x > 255)) return false;
  const [a, b, c, d] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  // documentation ranges (RFC 5737) and benchmarking (RFC 2544)
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (PUBLIC_EXAMPLE_IPS.has(m)) return false;
  // version-like: a product/version token ("Chrome/<a.b.c.d>") or a dotted
  // number ending in .0 (a host address never ends in .0)
  if (d === 0) return false;
  if (line[index - 1] === '/' && /[A-Za-z0-9]/.test(line[index - 2] ?? '')) return false;
  return true;
}

function homePathFinding(m) {
  if (/^\/(Users|home)\/(runner|user|username|me|you|node|app[\w.-]*|ubuntu)\//i.test(m)) return false;
  if (/Users[\\/]+(user|username|me|you|runneradmin|public|default|<)/i.test(m)) return false;
  return true;
}

const genericRules = [
  { id: 'email-address',
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}(?![A-Za-z])/g,
    keep: emailFinding },
  { id: 'public-ip-address', re: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, keep: ipFinding },
  { id: 'local-home-path', re: /(?:\/Users\/[A-Za-z][\w.-]+\/|\/home\/[a-z][\w.-]+\/|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+)/g,
    keep: homePathFinding },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g, noAllow: true },
];

const rules = [...genericRules, ...denyRules];

function mask(s) {
  return s.length <= 6 ? `${s[0]}…` : `${s.slice(0, 3)}…${s.slice(-2)}`;
}

const findings = [];
const suppressed = [];

// Returns the matching rules; records findings unless dryRun.
function scanLine(line, where, sc, { dryRun = false } = {}) {
  const allowed = line.includes('hygiene:allow');
  const hits = [];
  for (const rule of rules) {
    if (rule.secret ? !sc.internal : !sc.generic) continue;
    let matches;
    try {
      rule.re.lastIndex = 0;
      matches = [...line.matchAll(rule.re)];
    } catch {
      // never echo the pattern or the text
      console.error(`hygiene-check: ${rule.id} failed while matching (${where || 'path'})`);
      process.exit(2);
    }
    for (const m of matches) {
      if (rule.keep && !rule.keep(m[0], line, m.index)) continue;
      hits.push(rule);
      if (dryRun) break;
      if (allowed && !rule.noAllow) suppressed.push({ where, rule: rule.id });
      else findings.push({ where, rule: rule.id, shown: rule.secret ? '' : ` (${mask(m[0])})` });
      break;
    }
  }
  return hits;
}

// ---- paths: checked once each; a path that matches a denylist rule is withheld ----
const pathInfo = new Map();
function pathEntry(p) {
  let e = pathInfo.get(p);
  if (!e) {
    e = { n: pathInfo.size + 1, withheld: scanLine(p, '', SCOPES.internal, { dryRun: true }).length > 0 };
    e.display = e.withheld ? `<path #${e.n}>` : p;
    pathInfo.set(p, e);
  }
  return e;
}
const scannedPaths = new Set();
function scanPath(p, sc) {
  if (!p || p === '/dev/null' || scannedPaths.has(p)) return;
  scannedPaths.add(p);
  scanLine(p, `${pathEntry(p).display}:path`, sc);
}

// git quotes unusual paths as C strings unless core.quotePath=false
function unquote(p) {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes = [];
  const s = p.slice(1, -1);
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '\\') { bytes.push(...Buffer.from(s[i])); continue; }
    const o = /^[0-7]{3}/.exec(s.slice(i + 1));
    if (o) { bytes.push(parseInt(o[0], 8)); i += 3; continue; }
    const c = s[++i];
    bytes.push(...Buffer.from({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }[c] ?? c ?? ''));
  }
  return Buffer.from(bytes).toString('utf8');
}

const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.lock|uv\.lock|poetry\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/;

function scanDiff(content, sc) {
  let file = '?';
  let fileSc = sc;
  let commit = '';
  let lineNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const loc = () => `${commit}${pathEntry(file).display}:${lineNo}`;
  for (const l of content.split(/\r?\n/)) {
    // inside a hunk the line counts decide, so content like "++ x" is never a header
    if (oldLeft > 0 || newLeft > 0) {
      if (l.startsWith('+')) {
        scanLine(l.slice(1), loc(), fileSc);
        lineNo += 1;
        newLeft -= 1;
      } else if (l.startsWith('-')) {
        oldLeft -= 1;
      } else if (l.startsWith(' ') || l === '') {
        lineNo += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    const c = /^commit ([0-9a-f]{7,64})\b/.exec(l);
    if (c) { commit = `commit-${c[1].slice(0, 12)}:`; continue; }
    if (l.startsWith('+++ ')) {
      file = unquote(l.slice(4)).replace(/^b\//, '');
      // lockfiles carry registry URLs and hashes: internal terms only
      fileSc = LOCKFILE.test(file) ? { generic: false, internal: sc.internal } : sc;
      scanPath(file, sc);
      continue;
    }
    const r = /^(?:rename|copy) to (.+)$/.exec(l);
    if (r) { scanPath(unquote(r[1]), sc); continue; }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      lineNo = Number(h[2]);
      newLeft = h[3] === undefined ? 1 : Number(h[3]);
    }
  }
}

function scanPaths(content, sc) {
  const t = content.split('\0').map(s => s.replace(/^\n+/, ''));
  for (let i = 0; i < t.length; i += 1) {
    const st = /^([ACDMRTUXB])\d*$/.exec(t[i]);
    if (!st) continue;
    if (st[1] === 'R' || st[1] === 'C') { scanPath(t[i + 2], sc); i += 2; }
    else { if (st[1] !== 'D') scanPath(t[i + 1], sc); i += 1; }
  }
}

for (const input of inputs) {
  const content = read(input.src);
  if (input.kind === 'text') {
    content.split(/\r?\n/).forEach((l, i) => scanLine(l, `${input.label}:${i + 1}`, input.scope));
  } else if (input.kind === 'paths') {
    scanPaths(content, input.scope);
  } else {
    scanDiff(content, input.scope);
  }
}

if (suppressed.length) {
  console.error(`hygiene-check: ${suppressed.length} hit(s) skipped by hygiene:allow:`);
  for (const s of suppressed) console.error(`  ${s.where}  ${s.rule}`);
}
if ([...pathInfo.values()].some(e => e.withheld)) {
  console.error('hygiene-check: <path #N> is the N-th distinct path checked; its name matches an internal term.');
}
if (findings.length === 0) {
  console.log(`hygiene-check: clean (${denyRules.length} internal-term rules, ${genericRules.length} generic rules)`);
  process.exit(0);
}
console.error(`hygiene-check: ${findings.length} finding(s) in text that would become public:`);
for (const f of findings) console.error(`  ${f.where}  ${f.rule}${f.shown}`);
console.error('Remove or neutralise these (use example.com, <placeholder>, generic wording).');
console.error('If a line is a deliberate false positive, add "hygiene:allow" to it.');
process.exit(1);
