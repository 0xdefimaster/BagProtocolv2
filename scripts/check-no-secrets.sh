#!/usr/bin/env bash
# Fails when a real secret could be committed: any tracked .env file other
# than .env.example, or a 32-byte hex private key literal anywhere in the
# tracked tree. Tests generate throwaway keys at runtime instead.
set -euo pipefail

status=0

env_files=$(git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE '(^|/)\.env\.example$' || true)
if [ -n "$env_files" ]; then
  echo "Tracked .env files (remove them and rotate every value inside):"
  echo "$env_files"
  status=1
fi

# Quoted or assigned 0x + 64 hex, on a line that names a key/secret/mnemonic.
keys=$(git grep -nIiE "(private|secret|mnemonic|signer|attestor|deployer)[a-z_]*[\"']?[[:space:]]*[:=][[:space:]]*[\"']?(0x)?[0-9a-f]{64}\b" -- . ':!package-lock.json' || true)
if [ -n "$keys" ]; then
  echo "Private-key-like literals found:"
  echo "$keys"
  status=1
fi

if [ "$status" -eq 0 ]; then echo "No tracked secrets found."; fi
exit "$status"
