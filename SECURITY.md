# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to <security@borgels.com>.

Do not include API keys, access tokens, personal data or other secrets in
public GitHub issues. Include a concise description, the affected version,
reproduction steps and the impact where possible.

## Supported versions

Security fixes are made on the `main` branch and in the latest published
release.

## Scope

Reports about ways to get personal data, internal terms or secrets past the
check (a bypass of `scripts/gate.mjs`, `scripts/hygiene-check.mjs` or the
workflow) are security issues: report them privately as above, not in a
public issue, and do not include real denylist entries.
