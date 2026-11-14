#!/usr/bin/env bash
# Runs test/js/sql/sql-sync.test.ts with a given bun, against servers named in the
# environment (see harness.ts). The test is Bun's own file: it is copied beside the
# stand-in for Bun's harness, with the two certificates it reads.
#
#   stacks/tests/run.sh path/to/bun
set -euo pipefail
bun="${1:?usage: run.sh path/to/bun}"
here="$(cd "$(dirname "$0")" && pwd)"
sql="$here/../../test/js/sql"
mkdir -p "$here/docker-tls" "$here/mysql-tls/ssl"
cp "$sql/sql-sync.test.ts" "$here/sql-sync.test.ts"
cp "$sql/docker-tls/server.crt" "$here/docker-tls/server.crt"
cp "$sql/mysql-tls/ssl/ca.pem" "$here/mysql-tls/ssl/ca.pem"
cd "$here/.."
"$bun" --revision
exec "$bun" test tests/
