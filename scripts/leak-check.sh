#!/usr/bin/env bash
# Scan staged files (default) or the whole tracked+untracked tree (--all) for
# anything personal or secret-shaped. Exit 1 on a hit.
set -u
cd "$(git rev-parse --show-toplevel)"
MODE=staged
[ "${1:-}" = "--all" ] && MODE=all

if [ "$MODE" = all ]; then
  FILES=$(git ls-files --cached --others --exclude-standard)
else
  FILES=$(git diff --cached --name-only --diff-filter=ACMR)
fi

# Patterns are assembled from pieces so this file does not match itself.
T1="wps""a-app"
N1="jay""nne"
N2="Co""oke"
hits=0
report() { echo "LEAK-CHECK: $1: $2" >&2; hits=1; }

content() { # print the file content to scan
  if [ "$MODE" = all ]; then cat -- "$1"; else git show ":$1"; fi
}

for f in $FILES; do
  case "$f" in
    scripts/leak-check.sh|package-lock.json) continue ;;
  esac
  [ "$MODE" = all ] && [ ! -f "$f" ] && continue
  txt=$(content "$f" 2>/dev/null) || continue
  # skip binary
  printf '%s' "$txt" | grep -qI . || continue

  printf '%s\n' "$txt" | grep -nE 'eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}' >/dev/null && report "$f" "JWT-shaped string"
  printf '%s\n' "$txt" | grep -nE '\b[0-9a-fA-F]{64}\b' >/dev/null && report "$f" "64-char hex string (tenant/session id shaped)"
  printf '%s\n' "$txt" | grep -nE '\b[0-9]{2}-[0-9]{2}-[0-9]{2}\b.*\b[0-9]{8}\b|\b[0-9]{8}\b.*\b[0-9]{2}-[0-9]{2}-[0-9]{2}\b' >/dev/null && report "$f" "sort code + account number pattern"
  printf '%s\n' "$txt" | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | grep -viE '@([a-z0-9.-]+\.)?example\.(com|org|net)$' | grep -q . && report "$f" "non-placeholder email address"
  printf '%s\n' "$txt" | grep -qi -- "$T1" && report "$f" "real tenant domain"
  if [ "$f" != "LICENSE" ]; then
    printf '%s\n' "$txt" | grep -qi -- "$N1" && report "$f" "personal name/domain"
    printf '%s\n' "$txt" | grep -q -- "$N2" && report "$f" "personal surname"
  fi
done

[ "$hits" -eq 0 ] && echo "leak-check: clean ($MODE)" >&2
exit "$hits"
