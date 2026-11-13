#!/usr/bin/env bash
set -euo pipefail

if git describe --tags --abbrev=0 >/dev/null 2>&1; then
	version="$(npx --no-install tagger calculate-version)"
else
	version="0.0.0"
fi

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-SNAPSHOT)?$ ]]; then
	echo "Invalid release version: '$version'" >&2
	exit 1
fi

echo "$version"
