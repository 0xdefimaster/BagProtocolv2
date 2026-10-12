#!/usr/bin/env bash
# Netlify `ignore` command (netlify.toml): exit 0 skips the build, any other exit builds.
#
# Skips only when every file changed since the last deploy is one the site never ships:
# docs, Markdown, tests, CI workflows, Solidity contracts and operator scripts. Each skipped
# production deploy saves its Netlify credits. Anything uncertain builds: no previous deploy,
# a manual redeploy of the same commit (e.g. after changing an environment variable), or a
# previous commit this clone does not have.
set -u

base="${CACHED_COMMIT_REF:-}"
head="${COMMIT_REF:-}"
if [ -z "$base" ] || [ -z "$head" ] || [ "$base" = "$head" ]; then
  exit 1
fi
if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  exit 1
fi

if git diff --quiet "$base" "$head" -- . \
  ':!docs' ':!*.md' ':!*__tests__*' ':!*.test.ts' ':!*.test.tsx' \
  ':!.github' ':!contracts' ':!scripts' ':!reports' ':!archive'; then
  echo "Only docs, tests, CI, contracts or scripts changed since ${base}: skipping the build."
  exit 0
fi
exit 1
