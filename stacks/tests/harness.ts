// What `test/js/sql/sql-sync.test.ts` imports as "harness", for this repository's own runs.
//
// Bun's harness starts each database with docker compose. Here the servers are started by
// whoever runs the tests (the workflow, or you), and named in the environment:
//
//   SYNC_SQL_POSTGRES_PLAIN=127.0.0.1:5432   SYNC_SQL_POSTGRES_TLS=127.0.0.1:5433
//   SYNC_SQL_MYSQL_PLAIN=127.0.0.1:3306      SYNC_SQL_MYSQL_TLS=127.0.0.1:3307
//
// Each has to be what Bun's own containers are: a database `bun_sql_test`, a PostgreSQL role
// `bun_sql_test` that needs no password (`postgres` on the TLS one), a MySQL `root` without a
// password (`bun` on the TLS one), and the certificates of `test/js/sql`.
//
// A server that is not named is skipped. SYNC_SQL_REQUIRE lists the ones that must be there
// ("postgres_plain,mysql_plain"): a release is gated on them, so their absence fails the run.

import { describe, test } from "bun:test";

export const isWindows = process.platform === "win32";

type Container = { host: string; port: number; ready: Promise<void> };

const required = new Set((process.env.SYNC_SQL_REQUIRE ?? "").split(",").filter(Boolean));

export function describeWithContainer(label: string, options: { image: string }, body: (container: Container) => void) {
  const address = process.env[`SYNC_SQL_${options.image.toUpperCase()}`];
  if (!address) {
    if (required.has(options.image)) {
      test(`${label}: a server to test against`, () => {
        throw new Error(`SYNC_SQL_${options.image.toUpperCase()} is not set`);
      });
    }
    describe.skip(label, () => body({ host: "", port: 0, ready: Promise.resolve() }));
    return;
  }
  const at = address.lastIndexOf(":");
  const container = { host: address.slice(0, at), port: Number(address.slice(at + 1)), ready: Promise.resolve() };
  describe(label, () => body(container));
}
