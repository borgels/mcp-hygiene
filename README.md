# mcp-hygiene

A pre-merge check that keeps personal data and organisation-internal terms out
of public repositories.

## What is checked

On every pull request (and merge queue entry) the `public-hygiene` job scans:

- the lines **added** by the change, both the net diff (`base...head`) and each
  individual commit, so a value added in one commit and removed in a later one
  is still found,
- the paths of all added, modified, renamed and copied files, including binary
  and empty files,
- every commit message in `base..head`, the commit author and committer
  e-mail addresses (names: generic rules only), and the branch name,
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
is never printed, and a file path that matches is shown as `<path #N>` (the
N-th distinct path checked, in `git diff --name-status` order). Generic
findings are shown masked. Lockfiles are checked with internal-term rules only.

Not covered: the content of binary files (images, PDFs, office documents),
text in other encodings such as UTF-16, and text typed into the merge dialog.

## The check runs after publication

A pull request is public as soon as it is opened. A red check prevents the
merge, but the pushed commits stay reachable through the pull request, and
title/body edits keep a revision history. After a finding:

1. remove the value (amend or rebase the commits, edit the title/body),
2. delete the old revision from the title/body edit history,
3. if it matters, delete the workflow run log and ask GitHub Support to purge
   the pull request ref.

Running the scanner locally before pushing is the only real prevention:

```sh
git diff origin/main...HEAD | node scripts/hygiene-check.mjs --denylist ~/denylist.txt --diff -
git log -p --format='commit %H' origin/main..HEAD | node scripts/hygiene-check.mjs --denylist ~/denylist.txt --diff -
node scripts/hygiene-check.mjs --denylist ~/denylist.txt --label notes --text notes.md
```

Exit codes: `0` clean, `1` findings, `2` usage or configuration error.

## Fixing a finding

Replace the value with a neutral placeholder: `user@example.com`,
`192.0.2.10`, `<tenant-id>`, `/path/to/project`, or generic wording.

## Marking a false positive

Add the marker `hygiene:allow` anywhere on the affected line, for example in a
code comment:

```js
const SUPPORT = 'support@vendor.dev'; // hygiene:allow (vendor contact from public docs)
```

Lines containing the marker are skipped by every rule except `private-key`.
Skipped hits are still listed in the job log (location and rule only). For
gitleaks false positives use its own `gitleaks:allow` comment.

## Configuration

- `HYGIENE_DENYLIST` organisation secret (Actions, and Dependabot for
  Dependabot pull requests): newline-separated regular expressions, compiled
  with the `u` flag. A leading `i ` makes a pattern case-insensitive; `#`
  starts a comment. Patterns that are invalid or match the empty string stop
  the check with exit code 2.
- Pull requests from forks, and Dependabot runs without the secret, use the
  generic rules only; other same-repository changes fail if the secret is
  missing.
- `HYGIENE_ALLOWED_EMAILS` (env) or `--allow-emails-file FILE`: addresses that
  are always allowed.
- The workflow runs the scanner from this repository at `SCANNER_SHA`. After a
  scanner change, bump it in `.github/workflows/hygiene.yml`; CI warns while
  they differ.

## License

Apache-2.0
