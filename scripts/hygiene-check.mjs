#!/usr/bin/env node
// Public-text hygiene check: finds personal data, private network details and
// organisation-specific internal terms in text that is about to be published
// (added lines of a diff, commit messages, PR/issue text).
//
// Usage:
//   hygiene-check.mjs [--diff FILE|-] [--text FILE|-]... [--label NAME]
//                     [--denylist FILE] [--allow-emails-file FILE]
// Organisation-specific patterns come from --denylist FILE or the
// HYGIENE_DENYLIST environment variable (never commit them to a public repo).
// Denylist format: one regular expression per line; a leading "i " makes it
// case-insensitive; blank lines and lines starting with "#" are ignored.
// Matches of denylist patterns are never printed, only their rule number.
// A line containing "hygiene:allow" is skipped.
//
// Exit codes: 0 clean, 1 findings, 2 usage/config error.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const inputs = [];
let denylistFile;
let label = 'text';
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  const next = () => {
    const v = args[++i];
    if (v === undefined) usage(`${a} needs a value`);
    return v;
  };
  if (a === '--diff') inputs.push({ kind: 'diff', src: next() });
  else if (a === '--text') inputs.push({ kind: 'text', src: next(), label });
  else if (a === '--label') label = next();
  else if (a === '--denylist') denylistFile = next();
  else if (a === '-h' || a === '--help') usage();
  else usage(`unknown argument ${a}`);
}
if (inputs.length === 0) usage('nothing to check');

function usage(msg) {
  if (msg) console.error(`hygiene-check: ${msg}`);
  console.error('usage: hygiene-check.mjs [--diff FILE|-] [--label NAME --text FILE|-]... [--denylist FILE]');
  process.exit(2);
}

function read(src) {
  try {
    return src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8');
  } catch (e) {
    // an unreadable input must not look like "findings" (exit 1)
    console.error(`hygiene-check: cannot read ${src === '-' ? 'stdin' : src} (${e.code ?? e.message})`);
    process.exit(2);
  }
}

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
    try {
      denyRules.push({ id: `internal-term #${n}`, re: new RegExp(src, ci ? 'giu' : 'gu'), secret: true });
    } catch (e) {
      console.error(`hygiene-check: denylist line ${n} is not a valid regular expression`);
      process.exit(2);
    }
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
const EXTRA_ALLOWED_EMAIL = (process.env.HYGIENE_ALLOWED_EMAILS ?? '')
  .split(/[\s,]+/)
  .filter(Boolean)
  .map(s => s.toLowerCase());

// Organisation domains are covered by the private denylist; generically we only
// flag addresses at public mail providers, which are almost always personal.
const PERSONAL_MAIL = /@(gmail|googlemail|hotmail|outlook|live|msn|icloud|me|mac|yahoo|ymail|aol|proton|protonmail|pm|gmx|web|mail|yandex|zoho|fastmail|hey|tutanota|jubii|tdcadsl|stofanet|mail\.tele|privat)\.[a-z.]{2,}$/i;
function emailFinding(m) {
  const addr = m.toLowerCase();
  if (EXTRA_ALLOWED_EMAIL.includes(addr)) return false;
  if (ALLOWED_EMAIL.some(r => r.test(addr))) return false;
  return PERSONAL_MAIL.test(addr);
}

function ipFinding(m) {
  const p = m.split('.').map(Number);
  if (p.some(x => x > 255)) return false;
  const [a, b, c] = p;
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
  // well-known public resolvers used in examples/tests
  if (['1.1.1.1', '8.8.8.8', '8.8.4.4', '9.9.9.9'].includes(m)) return false;
  return true;
}

const genericRules = [
  { id: 'email-address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, keep: emailFinding },
  { id: 'public-ip-address', re: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, keep: ipFinding },
  { id: 'local-home-path', re: /(?:\/Users\/[A-Za-z][\w.-]+\/|\/home\/[a-z][\w.-]+\/|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+)/g,
    keep: m => !/\/(runner|user|username|me|you|node|app|ubuntu)\//i.test(m) && !/Users[\\/]+(user|username|me|you|runneradmin|<)/i.test(m) },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
];

const rules = [...genericRules, ...denyRules];

function mask(s) {
  return s.length <= 6 ? `${s[0]}…` : `${s.slice(0, 3)}…${s.slice(-2)}`;
}

const findings = [];
function scanLine(line, where) {
  if (line.includes('hygiene:allow')) return;
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    for (const m of line.matchAll(rule.re)) {
      if (rule.keep && !rule.keep(m[0])) continue;
      findings.push({ where, rule: rule.id, shown: rule.secret ? '' : ` (${mask(m[0])})` });
      break;
    }
  }
}

for (const input of inputs) {
  const content = read(input.src);
  if (input.kind === 'text') {
    content.split(/\r?\n/).forEach((l, i) => scanLine(l, `${input.label}:${i + 1}`));
    continue;
  }
  // unified diff: check added lines only, track file and new-file line numbers.
  // Hunk line counts are tracked so that an added line whose content starts
  // with "++ " is not mistaken for a "+++ b/file" header.
  let file = '?';
  let lineNo = 0;
  let skipFile = false;
  let oldLeft = 0;
  let newLeft = 0;
  const scanPath = p => {
    // new and renamed file names become public too
    if (p && p !== '/dev/null') scanLine(p, `${p}:path`);
  };
  for (const l of content.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      if (l.startsWith('+')) {
        if (!skipFile) scanLine(l.slice(1), `${file}:${lineNo}`);
        lineNo += 1;
        newLeft -= 1;
      } else if (l.startsWith('-')) {
        oldLeft -= 1;
      } else if (l.startsWith(' ') || l === '') {
        lineNo += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
      // "\ No newline at end of file" and anything else: no line consumed
      continue;
    }
    if (l.startsWith('+++ ')) {
      file = l.slice(4).replace(/^b\//, '');
      // lockfiles carry registry URLs and integrity hashes, not prose
      skipFile = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.lock|uv\.lock|poetry\.lock)$/.test(file);
      scanPath(file);
      continue;
    }
    const r = /^(?:rename|copy) to (.+)$/.exec(l);
    if (r) { scanPath(r[1]); continue; }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      lineNo = Number(h[2]);
      newLeft = h[3] === undefined ? 1 : Number(h[3]);
    }
  }
}

if (findings.length === 0) {
  console.log(`hygiene-check: clean (${denyRules.length} internal-term rules, ${genericRules.length} generic rules)`);
  process.exit(0);
}
console.error(`hygiene-check: ${findings.length} finding(s) in text that would become public:`);
for (const f of findings.slice(0, 200)) console.error(`  ${f.where}  ${f.rule}${f.shown}`);
console.error('Remove or neutralise these (use example.com, <placeholder>, generic wording).');
console.error('If a line is a deliberate false positive, add "hygiene:allow" to it.');
process.exit(1);
