#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
version="${1:?version is required}"

auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
git config --local http.https://github.com/.extraheader "AUTHORIZATION: basic $auth"
trap 'git config --local --unset-all http.https://github.com/.extraheader' EXIT

npx --no-install tagger tag --version "$version"
git ls-remote --exit-code --tags origin "refs/tags/$version" > /dev/null
