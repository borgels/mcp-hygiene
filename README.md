# mcp-hygiene

A pre-merge check that keeps personal data and organisation-internal terms out
of public repositories.

## What is checked

On every pull request (and merge queue entry) the `public-hygiene` job scans:

- the lines **added** by the change, both the net diff (`base...head`) and each
  individual commit (merge commits via `--remerge-diff`), so a value added in
  one commit and removed in a later one is still found,
- the paths of all added, modified, renamed and copied files, including binary
  and empty files,
- every commit message in `base..head`, the commit author and committer
  e-mail addresses (names: generic rules only), and the branch name,
- the pull request title and body,
- the commit range with [gitleaks](https://github.com/gitleaks/gitleaks)
  (built-in rules, pinned and checksum-verified, binary-looking files as text).

The workflow is thin: [`scripts/gate.mjs`](scripts/gate.mjs) collects the text
to check (`collect`, no secrets) and runs the scanner (`scan`); both are
pinned with the scanner and covered by the tests in `test/`. The pull request
title and body are read from the event file, so they are not repeated in the
logged step environment.

The scanner, [`scripts/hygiene-check.mjs`](scripts/hygiene-check.mjs) (Node 20+,
no dependencies), has two rule sets:

| Rules | Source | Examples |
| --- | --- | --- |
| Generic | this repository | addresses at public mail providers, public IPv4 addresses, local home directory paths, private keys |
| Internal terms | `HYGIENE_DENYLIST` secret | organisation-specific names and hosts, one regular expression per line |

Findings for internal terms are reported by rule number only; the matched text
is never printed. A file path that matches any rule is shown as `<path #N>`
(the N-th distinct path checked, in `git diff --name-status` order). Generic
findings are shown masked. Lockfiles are checked with internal-term rules only.

Binary files are read as text (`git diff --text`), so plain strings inside them
are found. Not covered: compressed or encoded content (images, PDFs, office
documents, base64), text in other encodings such as UTF-16, and text typed into
the merge dialog.

## The check runs after publication

A pull request is public as soon as it is opened. A red check prevents the
merge, but the pushed commits stay reachable through the pull request, and
title/body edits keep a revision history. After a finding:

1. remove the value (amend or rebase the commits, edit the title/body),
2. delete the old revision from the title/body edit history,
3. delete the logs of all workflow runs of the pull request (every run on
   open, edit and push scanned the text again), and if it matters ask GitHub
   Support to purge the pull request ref.

Running the scanner locally before pushing is the only real prevention:

```sh
git diff origin/main...HEAD | node scripts/hygiene-check.mjs --denylist ~/denylist.txt --diff -
git log -p --text --remerge-diff --format='commit %H' origin/main..HEAD | node scripts/hygiene-check.mjs --denylist ~/denylist.txt --diff -
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

Lines containing the marker are skipped by every rule except `private-key`; the
marker has no effect on file paths. Skipped hits are listed in the job log
(location and rule only) and counted in a warning on the checks page. For
gitleaks false positives use its own `gitleaks:allow` comment.

## Configuration

- `HYGIENE_DENYLIST` organisation secret, stored twice: for Actions, and for
  Dependabot (pull requests opened by Dependabot only receive Dependabot
  secrets). Set both from one file with
  `scripts/set-denylist-secrets.sh ORG FILE`, which validates the patterns and
  prints the rule count to compare with the run logs. Format:
  newline-separated regular expressions, compiled with the `u` flag. A leading
  `i ` makes a pattern case-insensitive; `#` starts a comment. Patterns that
  are invalid or match the empty string stop the check with exit code 2.
- Pull requests from forks never receive secrets and use the generic rules
  only. Every other run fails if the secret is missing.
- `HYGIENE_ALLOWED_EMAILS` (env) or `--allow-emails-file FILE`: addresses that
  are always allowed.
- `HYGIENE_ALLOWED_IDENTITIES` organisation secret (Actions and Dependabot,
  optional): exact commit author/committer e-mail addresses, separated by
  commas or whitespace, case-insensitive. In the commit identity fields these
  addresses get the generic rules only; the same address in file content,
  commit messages or pull request text is still checked with every rule.
- The workflow runs `scripts/` from this repository at `SCANNER_SHA`. After a
  change there, bump it in `.github/workflows/hygiene.yml`; CI warns on pull
  requests and fails on `main` while they differ.

## License

Apache-2.0
