# mcp-hygiene

A pre-merge check that keeps personal data and organisation-internal terms out
of public repositories.

## What is checked

On every pull request (and merge queue entry) the `public-hygiene` job scans:

- the lines **added** by the change (`git diff base...head`), including new and
  renamed file paths,
- every commit message in `base..head`,
- the pull request title and body,
- the commit range with [gitleaks](https://github.com/gitleaks/gitleaks)
  (built-in rules, pinned and checksum-verified).

The scanner, [`scripts/hygiene-check.mjs`](scripts/hygiene-check.mjs) (Node 20+,
no dependencies), has two rule sets:

| Rules | Source | Examples |
| --- | --- | --- |
| Generic | this repository | addresses at public mail providers, public IPv4 addresses, local home directory paths, private keys |
| Internal terms | `HYGIENE_DENYLIST` secret | organisation-specific names and hosts, one regular expression per line |

Findings for internal terms are reported by rule number only; the matched text
is never printed. Generic findings are shown masked.

A scheduled workflow (`daily-public-scan`) scans issues, pull requests,
comments, reviews and releases created or updated in all public repositories
during the last 48 hours, and fails if anything matches.

## Fixing a finding

Replace the value with a neutral placeholder: `user@example.com`,
`192.0.2.10`, `<tenant-id>`, `/path/to/project`, or generic wording.
Commit messages can be fixed with `git rebase` / `git commit --amend`,
the PR title and body by editing them (the check re-runs on edit).

## Marking a false positive

Add the marker `hygiene:allow` anywhere on the affected line, for example in a
code comment:

```js
const SUPPORT = 'support@vendor.dev'; // hygiene:allow (vendor contact from public docs)
```

Lines containing the marker are skipped by every rule. For gitleaks false
positives use its own `gitleaks:allow` comment.

## Running locally

```sh
git diff origin/main...HEAD | node scripts/hygiene-check.mjs --diff -
node scripts/hygiene-check.mjs --label notes --text notes.md --denylist ~/denylist.txt
```

Exit codes: `0` clean, `1` findings, `2` usage or configuration error.

## Configuration

- `HYGIENE_DENYLIST` organisation secret: newline-separated regular expressions.
  A leading `i ` makes a pattern case-insensitive; `#` starts a comment.
  Pull requests from forks do not receive secrets and run the generic rules
  only; same-repository changes fail if the secret is missing.
- `HYGIENE_ALLOWED_EMAILS` (optional env): addresses that are always allowed.

## License

Apache-2.0
