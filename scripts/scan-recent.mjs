#!/usr/bin/env node
// Scans recently created or updated public conversation text in every public
// repository of an organisation: issues, pull requests, issue comments, review
// comments, review bodies and releases. Runs hygiene-check.mjs on each item and
// prints only repository, item URL and rule id.
//
// Usage: scan-recent.mjs ORG [HOURS]
// Env:   GITHUB_TOKEN (public data only), HYGIENE_DENYLIST (passed through).
// Exit:  0 clean, 1 findings, 2 error or missing configuration.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [org, hoursArg = '48'] = process.argv.slice(2);
if (!org) {
  console.error('usage: scan-recent.mjs ORG [HOURS]');
  process.exit(2);
}
const hours = Number(hoursArg);
if (!Number.isFinite(hours) || hours <= 0) {
  console.error('scan-recent: HOURS must be a positive number');
  process.exit(2);
}
const since = new Date(Date.now() - hours * 3600_000).toISOString();
const token = process.env.GITHUB_TOKEN;
const CHECK = fileURLToPath(new URL('./hygiene-check.mjs', import.meta.url));
const BATCH = 50;

async function api(path, { all = true } = {}) {
  let url = path.startsWith('https://') ? path : `https://api.github.com${path}`;
  const out = [];
  while (url) {
    let res;
    for (let attempt = 1; ; attempt += 1) {
      res = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'public-hygiene-scan',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.status < 500 || attempt === 3) break;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
    // issues disabled, repository gone or blocked: nothing public to scan
    if ([404, 410, 451].includes(res.status)) return out;
    if (!res.ok) throw new Error(`GET ${new URL(url).pathname} -> HTTP ${res.status}`);
    const page = await res.json();
    out.push(...page);
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '');
    url = all && next ? next[1] : null;
  }
  return out;
}

const items = [];
const add = (repo, url, ...parts) => {
  const text = parts.filter(Boolean).join('\n');
  if (text.trim()) items.push({ repo, url, text });
};
const recent = ts => ts && ts >= since;

const repos = (await api(`/orgs/${org}/repos?type=public&per_page=100`))
  .filter(r => !r.private && !r.archived)
  .map(r => r.name)
  .sort();

let errors = 0;
for (const name of repos) {
  const base = `/repos/${org}/${name}`;
  try {
    const issues = await api(`${base}/issues?state=all&sort=updated&direction=desc&since=${since}&per_page=100`);
    for (const i of issues) add(name, i.html_url, i.title, i.body);

    for (const c of await api(`${base}/issues/comments?since=${since}&per_page=100`)) add(name, c.html_url, c.body);
    for (const c of await api(`${base}/pulls/comments?since=${since}&per_page=100`)) add(name, c.html_url, c.body);

    for (const pr of issues.filter(i => i.pull_request)) {
      for (const rv of await api(`${base}/pulls/${pr.number}/reviews?per_page=100`)) {
        if (recent(rv.submitted_at)) add(name, rv.html_url, rv.body);
      }
    }

    for (const rel of await api(`${base}/releases?per_page=100`, { all: false })) {
      if (recent(rel.created_at) || recent(rel.published_at)) add(name, rel.html_url, rel.name, rel.body);
    }
  } catch (e) {
    errors += 1;
    console.error(`scan-recent: ${name}: ${e.message}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'scan-recent-'));
const findings = new Set();
try {
  for (let start = 0; start < items.length; start += BATCH) {
    const chunk = items.slice(start, start + BATCH);
    const args = [CHECK];
    chunk.forEach((it, k) => {
      const file = join(dir, `item-${start + k}.txt`);
      writeFileSync(file, it.text);
      args.push('--label', `item-${start + k}`, '--text', file);
    });
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env });
    if (r.status === 0) continue;
    if (r.status !== 1) {
      // configuration errors carry no item text, so they are safe to show
      console.error(r.stderr.trim());
      process.exit(2);
    }
    for (const line of r.stderr.split('\n')) {
      const m = /^ {2}item-(\d+):\d+ {2}(internal-term #\d+|[a-z-]+)/.exec(line);
      if (!m) continue;
      const it = items[Number(m[1])];
      findings.add(`${it.repo}\t${it.url}\t${m[2]}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const denylistSet = Boolean((process.env.HYGIENE_DENYLIST ?? '').trim());
console.log(`scan-recent: ${repos.length} public repositories, ${items.length} items since ${since}`);
if (findings.size) {
  console.log(`scan-recent: ${findings.size} finding(s):`);
  for (const f of [...findings].sort()) console.log(`  ${f}`);
}
if (!denylistSet) console.error('scan-recent: HYGIENE_DENYLIST org secret not configured (generic rules only)');
if (errors) console.error(`scan-recent: ${errors} repositories could not be read`);
process.exit(findings.size ? 1 : !denylistSet || errors ? 2 : 0);
