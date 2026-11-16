#!/usr/bin/env sh
# Sets the HYGIENE_DENYLIST organisation secret for both GitHub Actions and
# Dependabot from one local file, after validating the patterns.
# Pull requests opened by Dependabot only receive Dependabot secrets, so both
# copies must stay identical.
#
# usage: scripts/set-denylist-secrets.sh ORG FILE
set -eu
if [ "$#" -ne 2 ]; then
  echo "usage: $0 ORG FILE" >&2
  exit 2
fi
org=$1
file=$2
if [ ! -s "$file" ]; then
  echo "set-denylist-secrets: $file is missing or empty" >&2
  exit 2
fi

# Invalid or empty-matching patterns make every check fail; validate first.
# Prints the rule count to compare with "N internal-term rules" in run logs.
HYGIENE_DENYLIST='' node "$(dirname "$0")/hygiene-check.mjs" --denylist "$file" --text - < /dev/null

for app in actions dependabot; do
  gh secret set HYGIENE_DENYLIST --org "$org" --app "$app" --visibility all < "$file"
done
echo "set-denylist-secrets: updated the actions and dependabot copies for $org"
