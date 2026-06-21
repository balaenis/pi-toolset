#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

cp "${FIXTURE_DIR}/templates/app.baseline.ts.txt" "${FIXTURE_DIR}/src/app.ts"
cp "${FIXTURE_DIR}/templates/heavy.baseline.ts.txt" "${FIXTURE_DIR}/src/heavy.ts"

echo "Fixture source files restored."
