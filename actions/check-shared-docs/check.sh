#!/usr/bin/env bash
#
# Compares a repository against the organization's canonical documentation in
# kanso-labs/.github, which the action has already checked out to
# .canonical-docs.
#
# Three assertions, each reported in full before the script exits, so one run
# tells you everything rather than one thing at a time.

set -euo pipefail

canonical='.canonical-docs'
failed=0

fail() {
  printf '::error::%s\n' "$1"
  failed=1
}

# --- 1. The conventions block -------------------------------------------------
#
# Delimited by HTML comments rather than matched by its first and last bullet.
# Markers survive a reordered or added bullet; a text match does not, and would
# fail in a way that reads like drift rather than like a broken check.

extract_block() {
  sed -n '/<!-- shared-conventions:start -->/,/<!-- shared-conventions:end -->/p' "$1"
}

if [[ ! -f AGENTS.md ]]; then
  fail 'AGENTS.md is missing. Every repository carries one; it is the file agents read.'
elif ! grep -q '<!-- shared-conventions:start -->' AGENTS.md; then
  fail "AGENTS.md has no <!-- shared-conventions:start --> marker. The block cannot be checked without it — see ${canonical}/CONVENTIONS.md."
else
  if ! diff -u \
    <(extract_block "${canonical}/CONVENTIONS.md") \
    <(extract_block AGENTS.md) > /tmp/conventions.diff; then
    fail 'The conventions block in AGENTS.md does not match CONVENTIONS.md in kanso-labs/.github. The canonical text is the one to change; this copy follows it.'
    cat /tmp/conventions.diff
  fi
fi

# --- 2. Community health files ------------------------------------------------
#
# A local copy suppresses the organization default entirely rather than merging
# with it, and nothing about the file says so. That is the failure worth
# catching: the repository looks fine and quietly stops using the shared text.

read -ra allowed <<< "${ALLOW_LOCAL:-}"

is_allowed() {
  local candidate="$1" entry
  for entry in ${allowed+"${allowed[@]}"}; do
    [[ "${entry}" == "${candidate}" ]] && return 0
  done
  return 1
}

for name in CODE_OF_CONDUCT.md CONTRIBUTING.md SECURITY.md SUPPORT.md; do
  for path in "${name}" ".github/${name}"; do
    if [[ -f "${path}" ]] && ! is_allowed "${name}"; then
      fail "${path} overrides the organization default, which is then not used at all. Delete it, or name it in this action's allow-local input with the reason recorded in AGENTS.md."
    fi
  done
done

if [[ -d .github/ISSUE_TEMPLATE ]] && ! is_allowed 'ISSUE_TEMPLATE'; then
  fail '.github/ISSUE_TEMPLATE overrides the organization default, which is then not used at all. Delete it, or name ISSUE_TEMPLATE in this action'"'"'s allow-local input.'
fi

# --- 3. The licence -----------------------------------------------------------
#
# LICENSE.md cannot be served as an organization default — GitHub excludes it,
# and a licence has to travel with the code — so every repository carries the
# same bytes instead.

if [[ ! -f LICENSE.md ]]; then
  fail 'LICENSE.md is missing. A public repository without one is all rights reserved, whatever its visibility suggests.'
elif ! cmp -s LICENSE.md "${canonical}/LICENSE.md"; then
  fail 'LICENSE.md differs from the organization copy. Every repository carries the same bytes; the formatters are told to leave it alone so they stay that way.'
  diff -u "${canonical}/LICENSE.md" LICENSE.md || true
fi

# ------------------------------------------------------------------------------

if (( failed )); then
  printf '\nShared documentation is out of step. The canonical copies live in https://github.com/kanso-labs/.github\n'
  exit 1
fi

printf 'Shared documentation matches kanso-labs/.github\n'
