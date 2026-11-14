# stacksjs/bun

[Bun](https://github.com/oven-sh/bun), with what Stacks needs added to it, kept on upstream's main and released for every official release.

This is Bun's own README's neighbour: the one at the root is upstream's, untouched. This one is about the fork.

## How the fork is laid out

The `stacks` branch is upstream's `main` with our commits on it. It is merged from upstream every six hours, never rebased, so it only ever grows, and GitHub's "ahead / behind" line reads as it should: ahead by our commits, behind by at most a few hours.

What is ours in the tree:

- **The changes to Bun's own source.** Ordinary commits. Today that is one change, described below.
- `test/js/sql/sql-sync.test.ts` and a section of `docs/runtime/sql.mdx` - the tests and the documentation of that change, where Bun keeps its own.
- `stacks/` - what belongs to the fork and not to Bun: `tests/` (how those tests are run here, against every binary that is built), `bench/` (what the change saves, measured by every Linux build), `patches/<tag>/` (a patch series pinned for one official release), `UPSTREAM` (the upstream commit this branch last merged) and `BUILDING.md`.
- `.github/workflows/stacks-sync.yml` - merges upstream, and starts a build when there is something to build.
- `.github/workflows/stacks-build.yml` - builds, tests and publishes.

Upstream's own workflows are not kept. They run on upstream's infrastructure and are removed again from each merge.

The `main` branch is GitHub's copy of upstream's `main`. Nothing here reads it; `stacks` merges from upstream directly.

## What it adds

Synchronous queries on Bun's MySQL and Postgres drivers. `bun:sqlite` runs a query where it is called; `Bun.sql` answers with a promise. With this fork a statement can be waited for where it is issued:

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

The types: `packages/bun-types` in this repository declares the four calls, but the `bun-types` on npm is official Bun's and does not. A project gets them from [bun-query-builder](https://github.com/stacksjs/bun-query-builder), opt-in, with one line in any of its files:

```ts
/// <reference types="bun-query-builder/bun-sync" />
```

Everything else is Bun's own API, unchanged, and a statement that is awaited behaves as before. The two can be mixed.

### How it waits

The calling thread blocks on the socket of the one connection that has the answer, and what arrives on that socket is handled exactly as a tick of the event loop would handle it, TLS and connecting included. The event loop itself does not turn. So while a statement is waited for, nothing else of the program runs: no other socket, no timer, no microtask. That is what `bun:sqlite` has always done, and it is the point: a nested tick would run other requests in the middle of the caller's statement.

It follows that a statement cannot be waited for when what it needs can only come from the event loop: a connection that code which `await`s is holding, or a password that is a promise. `wait()` says so with `null` instead of blocking for nothing.

Three things the event loop would otherwise do are done by the waiting call. A dial that failed because the server was still starting is tried again after its pause. Once a second the idle connections are read, so one that the server closed while the program did not yield leaves the pool before a statement is put on it. And `connectionTimeout` and `idleTimeout` are timers of the event loop, so a wait ends when one is due and fails the connection as the timer would: a server that accepts and then says nothing does not hold the caller for ever.

Two more cases answer `null`. A `COPY` query read with `readable()` or fed with `writable()` waits for code of the same program, which is the code that would block. And on macOS, a name that the system resolver is already looking up for a caller that awaits: only the event loop reads that answer. A dial that a waiting call starts itself is resolved on the thread pool, where it can see the answer; every other dial resolves as Bun always has.

### Who uses it

[bun-query-builder](https://github.com/stacksjs/bun-query-builder), and through it Stacks' models and `db`: `const user = User.where(...).first()` is the row on SQLite, MySQL and Postgres. On stock Bun it gets there by keeping the connection on a worker thread and blocking the caller on it. On this Bun it uses the calls above on the calling thread: no second thread, and no copy of the rows between two. It looks at the runtime and picks; nothing in Stacks requires this fork.

## Releases

A release is an official release with our changes on it, never this branch as it is: `bun-v1.4.4-stacks.1` is `bun-v1.4.4` plus the changes. Its assets use the official names (`bun-linux-x64.zip`, `bun-darwin-aarch64.zip`) and layout, with a `SHASUMS256.txt` beside them.

`stacks-sync` looks for the latest official release every six hours. If there is none of ours for it, it starts `stacks-build` for that tag, which:

1. checks the tag out from oven-sh/bun;
2. puts our changes on it: the series in `stacks/patches/<tag>/` if that tag has one, otherwise everything this branch changes in Bun's source (the difference to `stacks/UPSTREAM`, without `.github` and `stacks/`), merged onto the tag three ways;
3. builds each target, and runs the tests with the binary it built (see "The tests" below);
4. publishes, if every target built and passed. A target that fails fails the build, and nothing is published: the previous release stays the latest.

So a new official release becomes ours without anyone asking, as long as the changes still fit it.

## Installing it

With [pantry](https://github.com/pantry-pm/pantry), as `stacksjs.com/bun`, in place of `bun.com`:

```yaml
# deps.yaml
dependencies:
  stacksjs.com/bun: ^1.4.4
```

The version there is the official version plus the number of our release of it: `bun-v1.4.4-stacks.2` is `1.4.4.2`, and `^1.4.4` takes the newest. It installs `bun` and `bunx`, as `bun.com` does, so a project has one or the other. The registry publishes each release within the hour (the build tells it; it also looks by itself), after checking the download against `SHASUMS256.txt` and that the binary has the calls.

Without pantry, the zips of a release are the official ones in name and layout.

## The tests

`test/js/sql/sql-sync.test.ts` is written for Bun's test suite: it asks Bun's harness for a container per server (`postgres_plain`, `postgres_tls`, `mysql_plain`, `mysql_tls`) and has two tests for SQLite. Here the same file runs with `stacks/tests/harness.ts` in the harness's place, which takes the servers from the environment instead of starting containers:

```bash
SYNC_SQL_POSTGRES_PLAIN=127.0.0.1:5432 SYNC_SQL_MYSQL_PLAIN=127.0.0.1:3306 \
  stacks/tests/run.sh path/to/bun
```

`harness.ts` says what each server has to be. One that is not named is skipped, unless `SYNC_SQL_REQUIRE` lists it. The build runs all four on Linux (PostgreSQL 17 and MySQL 8.4, the TLS ones built from the Dockerfiles and certificates in `test/js/sql`) and the two plain ones on macOS, whose runner has no docker.

## Upstream, and why this is a fork

The change was proposed to Bun as [oven-sh/bun#48947](https://github.com/oven-sh/bun/issues/48947), with [oven-sh/bun#48948](https://github.com/oven-sh/bun/pull/48948) as the implementation: this branch's change on Bun's `main`, with the types, the docs and the tests.

The issue was closed as not planned ([the reasons](https://github.com/oven-sh/bun/issues/48947#issuecomment-6883154514)):

- `Bun.sql` returns promises on every adapter by design, SQLite included.
- Bun does not want a call in the runtime that blocks the JavaScript thread on a network socket. `Bun.spawnSync` waits on an event loop of its own for that reason; this change dispatches a socket of the main loop outside a tick.
- The same result is possible on official Bun today: a worker thread owns the connection, and the caller waits for it with `Atomics.wait()` and `receiveMessageOnPort()`.

That last point is true, and it is what [bun-query-builder](https://github.com/stacksjs/bun-query-builder) does on official Bun. So nothing needs this fork to work. What the fork is for is what that worker costs, which the next section measures. The pull request stays open; its review found real defects, which are fixed here and there.

## What it saves

`stacks/bench/sync-sql.bench.ts` times one query three ways on the Bun that runs it: `executeSync()`, the worker thread described above, and `await` for scale. Every Linux build runs it after the tests and writes the table to the run's summary. From [run 43642390000](https://github.com/stacksjs/bun/actions/runs/43642390000), on a GitHub-hosted `ubuntu-24.04` runner with PostgreSQL 17 and MySQL 8.4 on the same machine, in microseconds per query on one connection, the fastest of 9 rounds with the median in brackets:

| Server | Query | `executeSync()` | Worker thread | `await` | Worker over `executeSync()` |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL | select 1 | 60 (63) | 84 (87) | 60 (63) | 1.40x |
| PostgreSQL | 100 rows of 1 KB | 180 (183) | 234 (244) | 169 (172) | 1.30x |
| PostgreSQL | 1000 rows of 1 KB | 1062 (1120) | 1482 (1516) | 1020 (1102) | 1.40x |
| MySQL | select 1 | 63 (64) | 83 (87) | 60 (64) | 1.31x |
| MySQL | 100 rows of 1 KB | 323 (332) | 404 (408) | 318 (339) | 1.25x |
| MySQL | 1000 rows of 1 KB | 2594 (2771) | 3105 (3197) | 2661 (2762) | 1.20x |

What the numbers say:

- `executeSync()` costs what `await` costs. Waiting on the socket adds nothing that can be measured here.
- The worker takes 1.2 to 1.4 times as long: about 20 microseconds more on the smallest query, and about half a millisecond more on a megabyte of rows, which is the copy from one thread to the other.
- The database is on the same machine. Over a network the round trip is added to all three columns alike, so the ratio shrinks toward 1 while the difference in microseconds stays.

Beyond time, the worker is a second thread with a JavaScript heap of its own in every process, and the rows the caller gets are copies, not the driver's own objects.

To measure on another machine, with the servers the tests use:

```bash
SYNC_SQL_POSTGRES_PLAIN=127.0.0.1:5432 SYNC_SQL_MYSQL_PLAIN=127.0.0.1:3306 \
  path/to/bun stacks/bench/sync-sql.bench.ts
```

On official Bun the `executeSync()` column reads "not on this Bun" and the other two are measured.

## When upstream changes the same code

There are two moments this can show, and the first is the reason the branch follows `main`:

- **A merge of upstream conflicts.** `stacks-sync` pushes nothing and opens an issue naming the files. Merge by hand, carry the change forward, push:

  ```bash
  git fetch https://github.com/oven-sh/bun.git main
  git merge FETCH_HEAD            # resolve; keep upstream's workflows deleted
  git rev-parse FETCH_HEAD > stacks/UPSTREAM && git add stacks/UPSTREAM
  git commit && git push
  ```

  After every merge the branch is built as it is (Linux), so a change of upstream's that breaks ours without a conflict is seen as well.

- **The changes do not fit an official tag.** The tag is older than the `main` the changes are written against, and upstream may have rewritten the same code in between. The build then stops at "Put our changes on the tag". Make the series for that tag and commit it under `stacks/patches/<tag>/`:

  ```bash
  git clone --depth 1 --branch <tag> https://github.com/oven-sh/bun.git && cd bun
  # ... make the change on the tag, commit ...
  git format-patch -N --zero-commit -o ../stacks/patches/<tag> <tag>
  ```

  `bun-v1.4.4` has one: upstream moved the Postgres connection to another binding generator and rewrote the resolver after it.

## The token a merge needs

A merge of upstream carries upstream's commits, and some of those change upstream's workflow files. GitHub does not let the token of a workflow run push such commits. `stacks-sync` uses the secret `STACKS_SYNC_TOKEN` when it is set: a fine-grained personal access token for this repository with **Contents** and **Workflows** set to read and write. Without it a merge is pushed only when the commits it brings touch no workflow file, and fails otherwise until the next one that can.

## Status

Released: the changes above, on `bun-v1.4.4`. Every release is built by a run of `stacks-build` that passed the tests on both targets; the release notes name the run.

A build takes about 20 minutes on Linux and 30 on macOS. GitHub's macOS arm64 runners can be short: a job that no runner takes within 15 minutes is cancelled, and that job has to be run again.

What is not done:

- **The Linux binary needs glibc 2.39** (Ubuntu 24.04, Debian 13), where upstream's runs on 2.17. Upstream links against a glibc 2.31 sysroot; that sysroot is not provisioned here yet (the recipe is in upstream's `scripts/build/ci-images/spec.ts`, see `stacks/BUILDING.md`), so the binary needs the glibc of the runner that built it. That runner is `ubuntu-24.04` by name, and a build whose binary needs anything newer fails. `bun-v1.4.4-stacks.1` was built on `ubuntu-latest` after it became 26.04: it needs glibc 2.43, and does not start on 24.04.
- **Two targets of upstream's eighteen.** No `linux-aarch64`, musl, Windows, FreeBSD or Android builds, and no `-profile` zips.
- **No cross-language LTO**, which upstream ships with. It needs far more memory at link than a hosted runner has.
- **Windows.** The wait is written against the epoll and kqueue loop. Under libuv `wait()` answers `null`, so `executeSync()` throws: use `await` there.
