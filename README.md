# stacksjs/bun

[Bun](https://github.com/oven-sh/bun), with the patches Stacks needs, rebuilt for every official release.

This branch holds no Bun source. It holds what turns an official Bun release into ours:

- `patches/` - the patch series, applied in order on top of the upstream release tag.
- `.github/workflows/track-upstream.yml` - checks for a new official release every six hours and starts a build for it.
- `.github/workflows/build.yml` - checks out the upstream tag, applies `patches/`, builds, and can publish the result as a release of this repository.

So a release here is always "that official tag, plus these patches", and it can be reproduced from the two.

## What the patches add

Synchronous queries on Bun's MySQL and Postgres drivers. `bun:sqlite` runs a query where it is called; `Bun.sql` answers with a promise. With the patches a statement can be waited for where it is issued:

```ts
import { SQL } from 'bun'

const sql = new SQL('postgres://localhost/app')

const users = sql`select * from users where id = ${id}`.executeSync() // the rows, or a throw
const orders = sql.unsafe('select * from orders where user_id = $1', [id]).executeSync(5000)

const tx = sql.reserveSync() // a connection of the caller's own
tx.unsafe('BEGIN').executeSync()
tx.unsafe('update accounts set balance = balance - 10 where id = 1').executeSync()
tx.unsafe('COMMIT').executeSync()
tx.release()
```

| Call | What it does |
|---|---|
| `query.executeSync(ms?)` | Runs the statement and returns its result, or throws what it failed with. After `ms` milliseconds without an answer it throws `ERR_POSTGRES_SYNC_TIMEOUT` / `ERR_MYSQL_SYNC_TIMEOUT`; the statement keeps running and can still be awaited or cancelled. |
| `query.wait(ms?)` | Starts the statement and blocks until it has settled. `true`: settled. `false`: `ms` passed. `null`: nothing this thread can wait on, so only the event loop can settle it. |
| `query.cancelSync(ms?)` | `cancel()`, then blocks until the request to stop the statement has reached the server. PostgreSQL sends that request on a connection of its own; left to the event loop it would go out after whatever the caller does next. |
| `sql.reserveSync(ms?)` | `sql.reserve()` where it is called. `undefined` when no connection can be had without the event loop turning. |

Everything else is Bun's own API, unchanged, and a statement that is awaited behaves as before. The two can be mixed.

### How it waits

The calling thread blocks on the socket of the one connection that has the answer, and what arrives on that socket is handled exactly as a tick of the event loop would handle it, TLS and connecting included. The event loop itself does not turn. So while a statement is waited for, nothing else of the program runs: no other socket, no timer, no microtask. That is what `bun:sqlite` has always done, and it is the point: a nested tick would run other requests in the middle of the caller's statement.

It follows that a statement cannot be waited for when what it needs can only come from the event loop: a connection that code which `await`s is holding, or a password that is a promise. `wait()` says so with `null` instead of blocking for nothing.

Two things the event loop would otherwise do are done by the waiting call: a dial that failed because the server was still starting is tried again after its pause, and once a second the idle connections are read, so one that the server closed while the program did not yield leaves the pool before a statement is put on it.

### Who uses it

[bun-query-builder](https://github.com/stacksjs/bun-query-builder), and through it Stacks' models and `db`: `const user = User.where(...).first()` is the row on SQLite, MySQL and Postgres. On stock Bun it gets there by keeping the connection on a worker thread and blocking the caller on it. On this Bun it uses the calls above on the calling thread: no second thread, and no copy of the rows between two. It looks at the runtime and picks; nothing in Stacks requires this fork.

## Status

The first patch is released. Every release is built by `build.yml` from an official tag plus `patches/`, and each target's job ends by running `tests/` with the binary it just built, against a real PostgreSQL 17 and a real MySQL 8.4. A target that fails them fails the build, and nothing is published.

[Run 43422719236](https://github.com/stacksjs/bun/actions/runs/43422719236) is the build the patch was accepted on, 32 of 32 tests on each target:

| Target | Runner | `bun --revision` |
|---|---|---|
| `linux-x64` | `ubuntu-latest` (4 vCPU, 16 GB) | `1.4.4` plus the patched revision |
| `darwin-aarch64` | `macos-15` | `1.4.4` plus the patched revision |

A build takes about 20 minutes on Linux and 30 on macOS. GitHub's macOS arm64 runners can be short: a job that no runner takes within 15 minutes is cancelled, and the build has to be started again.

What is not done:

- **The Linux binary needs glibc 2.43**, the runner's. Upstream links against a glibc 2.31 sysroot so its binary runs on older distributions; that sysroot is not provisioned here yet (the recipe is in upstream's `scripts/build/ci-images/spec.ts`, see BUILDING.md).
- **Two targets of upstream's eighteen.** No `linux-aarch64`, musl, Windows, FreeBSD or Android builds, and no `-profile` zips. On Windows the calls answer that there is nothing to wait on.
- **No cross-language LTO**, which upstream ships with. It needs far more memory at link than a hosted runner has.
- **TLS connections are not covered by the tests.** The code path is the event loop's own, but no test server here speaks TLS.
- **No type declarations.** `bun-types` does not know the three calls.

## Releases

A release is named after the official one it is built from, with our revision: `bun-v1.4.4-stacks.1`. Its assets use the official names (`bun-linux-x64.zip`, `bun-darwin-aarch64.zip`, ...) and layout, with a `SHASUMS256.txt` beside them.

## When a patch stops applying

`track-upstream` builds whatever `patches/` is at the time, once per official release per state of the queue. If a patch no longer applies to a new official release, the build fails at the `git am` step and no release is made: the previous release stays the latest. Refresh the patch against the new tag and commit it here; the next check builds it, or run `build.yml` for that tag by hand. While `patches/` is empty the tracker starts nothing.

## Adding a patch

```bash
git clone --depth 1 --branch bun-v1.4.4 https://github.com/oven-sh/bun.git && cd bun
git am ../patches/*.patch        # the series so far
# ... change, commit ...
git format-patch -N --zero-commit -o ../patches bun-v1.4.4
```

Keep a patch small and in files of its own where it can be: every line it touches in an upstream file is a line a future release can conflict with.

The `main` branch is GitHub's copy of upstream from the day this fork was made. It is not kept in step and nothing here reads it.
