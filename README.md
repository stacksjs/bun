# stacksjs/bun

[Bun](https://github.com/oven-sh/bun), with the patches Stacks needs, rebuilt for every official release.

This branch holds no Bun source. It holds what turns an official Bun release into ours:

- `patches/` - the patch series, applied in order on top of the upstream release tag.
- `.github/workflows/track-upstream.yml` - checks for a new official release every six hours and starts a build for it.
- `.github/workflows/build.yml` - checks out the upstream tag, applies `patches/`, builds, and can publish the result as a release of this repository.

So a release here is always "that official tag, plus these patches", and it can be reproduced from the two.

## Status

**Nothing has been released from this repository yet.** `patches/` is empty, so a build today is an unmodified Bun, and the tracker starts nothing while it is.

What is proven: the release build runs on GitHub's hosted runners. [Run 43340878329](https://github.com/stacksjs/bun/actions/runs/43340878329) built `bun-v1.4.4` unmodified, without cross-language LTO:

| Target | Runner | Wall time | `bun --revision` |
|---|---|---|---|
| `linux-x64` | `ubuntu-latest` (4 vCPU, 16 GB) | 19 minutes | `1.4.4+38afee6c8` |
| `darwin-aarch64` | `macos-15` | 27 minutes | `1.4.4+38afee6c8` |

That is the official revision. The macOS binary was downloaded and run: `bun:sqlite`, `Bun.sql` against Postgres and `node:worker_threads` all answer.

What is not done:

- **No patch exists yet.** The synchronous MySQL and Postgres calls below are the reason for this fork and have not been written.
- **The Linux binary needs glibc 2.43**, the runner's. Upstream links against a glibc 2.31 sysroot so its binary runs on older distributions; that sysroot is not provisioned here yet (the recipe is in upstream's `scripts/build/ci-images/spec.ts`, see BUILDING.md).
- **Two targets of upstream's eighteen.** No `linux-aarch64`, musl, Windows, FreeBSD or Android builds, and no `-profile` zips.
- **No cross-language LTO**, which upstream ships with. It needs far more memory at link than a hosted runner has.
- **The release job has never run.** It is skipped while `patches/` is empty.

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
