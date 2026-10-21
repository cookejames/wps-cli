#!/usr/bin/env bash
set -eu
cd "$(git rev-parse --show-toplevel)"
hook=.git/hooks/pre-commit
cat > "$hook" <<'HOOK'
#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/scripts/leak-check.sh"
HOOK
chmod +x "$hook"
echo "installed $hook"
