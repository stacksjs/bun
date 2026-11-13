# stacksjs/bun

[Bun](https://github.com/oven-sh/bun), with the patches Stacks needs, rebuilt for every official release.

This branch holds no Bun source. It holds what turns an official Bun release into ours:

- `patches/` - the patch series, applied in order on top of the upstream release tag.
- `.github/workflows/track-upstream.yml` - checks for a new official release every six hours and starts a build for it.
- `.github/workflows/build.yml` - checks out the upstream tag, applies `patches/`, builds, and can publish the result as a release of this repository.

So a release here is always "that official tag, plus these patches", and it can be reproduced from the two.

## Status

**Nothing has been released from this repository yet.** `patches/` is empty, so a build today is an unmodified Bun. The first goal is narrower: prove the release build runs on the runners this repository has. Upstream builds on machines with 16 vCPU and 128 GB of memory; GitHub's hosted runners have 4 vCPU and 16 GB.

## What the patches are for

Synchronous queries on Bun's MySQL and Postgres drivers. `bun:sqlite` runs a query where it is called; `Bun.sql` answers with a promise. Stacks' model layer returns values in place on all three (`const user = User.where(...).first()`), and for the network drivers it currently does that by holding the connection on a worker thread ([bun-query-builder](https://github.com/stacksjs/bun-query-builder), `src/sync-driver.ts`). A native synchronous call would remove the second thread and the copy between them. Nothing in Stacks depends on this fork: the worker path stays as the default for stock Bun.

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
