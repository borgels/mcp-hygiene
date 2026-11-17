#!/usr/bin/env sh
# Sets the HYGIENE_DENYLIST organisation secret for both GitHub Actions and
# Dependabot from one local file, after validating the patterns. With a third
# argument, also sets HYGIENE_ALLOWED_IDENTITIES (one address per line or
# comma-separated) for both.
# Pull requests opened by Dependabot only receive Dependabot secrets, so both
# copies must stay identical.
#
# usage: scripts/set-denylist-secrets.sh ORG DENYLIST_FILE [ALLOWED_IDENTITIES_FILE]
set -eu
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 ORG DENYLIST_FILE [ALLOWED_IDENTITIES_FILE]" >&2
  exit 2
fi
org=$1
file=$2
ids=${3:-}
if [ ! -s "$file" ]; then
  echo "set-denylist-secrets: $file is missing or empty" >&2
  exit 2
fi

# Invalid or empty-matching patterns make every check fail; validate first.
# The rule count is compared with "N internal-term rules" in run logs.
out=$(HYGIENE_DENYLIST='' node "$(dirname "$0")/hygiene-check.mjs" --denylist "$file" --text - < /dev/null)
echo "$out"
rules=$(printf '%s\n' "$out" | sed -nE 's/.*clean \(([0-9]+) internal-term rules.*/\1/p')
if [ -z "$rules" ] || [ "$rules" -eq 0 ]; then
  echo "set-denylist-secrets: $file has no rules; refusing to set it" >&2
  exit 2
fi

if [ -n "$ids" ]; then
  if [ ! -s "$ids" ]; then
    echo "set-denylist-secrets: $ids is missing or empty" >&2
    exit 2
  fi
  # one comma-separated line; '#' starts a comment
  allowed=$(sed -e 's/#.*//' "$ids" | tr ',[:space:]' '\n\n' | sed '/^$/d' | paste -sd, -)
  case "$allowed" in
    *@*) ;;
    *) echo "set-denylist-secrets: $ids contains no e-mail address" >&2; exit 2 ;;
  esac
fi

for app in actions dependabot; do
  gh secret set HYGIENE_DENYLIST --org "$org" --app "$app" --visibility all < "$file"
  if [ -n "$ids" ]; then
    printf '%s' "$allowed" | gh secret set HYGIENE_ALLOWED_IDENTITIES --org "$org" --app "$app" --visibility all
  fi
done
echo "set-denylist-secrets: updated the actions and dependabot copies for $org ($rules rules${ids:+, identity allowlist})"
