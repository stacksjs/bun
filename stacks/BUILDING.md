# Building Bun `bun-v1.4.4` on GitHub-hosted runners: findings

> **Result, added after the first run.** The notes below were written before the
> workflow had ever run, from reading upstream's build system, and they keep
> their estimates as written. Run
> [43340878329](https://github.com/stacksjs/bun/actions/runs/43340878329) then
> built both targets with `lto: false`: `linux-x64` in 19 minutes and
> `darwin-aarch64` in 27, each reporting `1.4.4+38afee6c8`. So the estimates at
> the end ("roughly even odds" for Linux, "unlikely" for macOS) were too
> pessimistic, and every guessed step listed under "Guessed rather than read"
> worked as written. Still unmeasured: `lto: true`, and anything about memory
> headroom (the diagnostics artifacts of that run have the samples).

Everything below was read from files at the tag over
`https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.4/<path>`. Nothing was
cloned, built or run. Line numbers are of the file at that tag. `stacks-build.yml` had never been executed when this was written.

## Corrections to the starting assumptions

Three things differ from what the brief assumed, and they shape the workflow:

1. **Upstream no longer splits cpp / rust / link.** One Buildkite step per target
   does "deps + C++ + Rust + link on one agent" (`.buildkite/ci.ts` 610-637,
   `getBuildBunStep`). The r8g.4xlarge is that whole step for LTO lanes; the
   r8g.8xlarge is the same single step for lanes without C/C++ LTO, chosen for
   its 32 vCPUs (`.buildkite/ci.ts` 496-510).
2. **Upstream builds nothing natively.** Every target, linux-x64 and
   darwin-aarch64 included, is cross-compiled from one Debian 13 **aarch64**
   image (`.buildkite/ci.ts` 180-188, 249-290: "there is no native macOS or Windows
   build"). A native x64 Linux build and a native macOS build are the
   contributor path, not the path that produces the shipped zips.
3. **`--lto=off` does not remove LTO from the link.** Release Rust crates are
   always ThinLTO bitcode and the linker optimises them, with or without `lto`
   (`scripts/build/flags.ts` 1528-1538 `rustLtoInLink`; `scripts/build/rust.ts`
   508-518). `--lto=off` only takes the C/C++ and the JavaScriptCore prebuilt
   out of that graph.

## 1. Toolchain for a Linux x64 build machine, and how upstream provisions it

Source of truth: `scripts/build/ci-images/spec.ts`. It holds every pin
(`pins`, 112-418), the package lists, and one function per tool; `tools()`
(2005-2073) gives the order. It generates a bootstrap shell script per image;
there is no checked-in `bootstrap.sh` or Dockerfile at this tag
(`scripts/bootstrap.sh` is a 404).

| Tool | Pin | How upstream installs it | Where |
|---|---|---|---|
| apt packages | distro's | `build-essential ccache golang libtool make nasm ninja-build perl pkg-config python3 ruby` plus `curl git unzip xz-utils ...` | spec.ts 513-541 |
| Node.js | 26.3.0 | nodejs.org tarball into /usr/local | spec.ts 113-129, 803-871 |
| bootstrap bun | 1.4.2 | `github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-<platform>.zip`, sha256 checked, to /usr/local/bin/bun | spec.ts 130-143, 873-889 |
| ninja | oven-sh/ninja `bun-ninja-5ecd8831` | zip into /opt/bun-ninja; elsewhere the build fetches it itself into the cache and falls back to `ninja` on PATH | spec.ts 330-340, 898-912; `scripts/build/ninja-release.ts` 85-130 |
| cmake | 3.30.5 | Kitware `.sh` installer, `--prefix=/usr` | spec.ts 168-175, 1003-1022 |
| LLVM | 23.1.1 | `LLVM-23.1.1-Linux-X64.tar.xz` from llvm-project releases, sha256 checked, only `bin/<llvmPrograms>` and `lib/clang/23` extracted to `/opt/llvm`, then `/opt/llvm/bin` on PATH; plus Ubuntu jammy's `libicu70_70.1-2` deb because LLVM's lld is linked against ICU 70 | spec.ts 176-193, 602-613, 1024-1095 |
| Rust | nightly-2026-09-15, rustup 1.28.2 | `rustup-init -y --no-modify-path --profile minimal --default-toolchain <channel> --component rust-src,rustfmt,clippy,miri,llvm-tools --target <11 targets>` with RUSTUP_HOME=CARGO_HOME=/opt/rust | spec.ts 194-222, 1102-1156 |
| glibc sysroot | ubuntu:20.04 (glibc 2.31) + gcc-13 libstdc++ | skopeo copy of the image, 5 pinned debs, gcc-13 debs from `oven-sh/WebKit` release `gcc-13-focal-debs`, into `/opt/linux-sysroot-glibc` | spec.ts 239-298, 1238-1301 |

What the build actually requires, from `scripts/build/tools.ts` and
`scripts/build/configure.ts`:

- clang and ld.lld are version-checked against `>=23.1.0 <23.1.99`, not exactly
  23.1.1 (tools.ts 380-382, 472-487). Exact equality for bun, cmake, node and
  clang is only enforced when `BUILDKITE=true` (`checkImageTools`, tools.ts
  146-166; called at configure.ts 460-462).
- clang's LLVM major must equal rustc's LLVM major (config.ts 1021-1037).
- Required: `clang`, `clang++`, `llvm-ar`, `llvm-ranlib`, `ld.lld`, GNU `strip`
  (Linux), `cmake`, `perl`, bun. Optional: `nasm` (needed on x64 for
  libjpeg-turbo SIMD), `ccache`, `llvm-nm/readobj/objdump/cxxfilt` (the binary
  checks are skipped without them). tools.ts 554-693, configure.ts 117-119, 421-427.
- LLVM search path: `BUN_TOOLCHAIN_LLVM` if set (then no version check), else
  Homebrew kegs on macOS, `/usr/lib/llvm-23*/bin`, then PATH (tools.ts 394-445).
- Rust: configure runs `rustup -q toolchain install <channel> --profile minimal
  --component rust-src` itself and pins `RUSTUP_TOOLCHAIN` so the 11 targets
  and extra components of `rust-toolchain.toml` (~2.4 GB) are not installed
  (tools.ts 776-833). std is always rebuilt from source with `-Zbuild-std`
  (rust.ts 285-305), which is why rust-src is needed and the target lists are not.
- The glibc sysroot is optional for a native build: "Local dev without a sysroot
  builds native" (config.ts 1160-1196).

Contributor docs (`docs/project/contributing.mdx`):

- Ubuntu packages, line 32: `sudo apt install curl wget lsb-release software-properties-common cmake git golang libtool ninja-build pkg-config ruby-full xz-utils`
- macOS, line 28: `brew install automake ccache cmake coreutils gnu-sed go icu4c libiconv libtool ninja pkg-config rustup-init ruby`
- Rust, lines 49-53: rustup from sh.rustup.rs.
- LLVM on Ubuntu, line 109: `wget https://apt.llvm.org/llvm.sh -O - | sudo bash -s -- 23 all`
- LLVM on macOS, lines 104 and 141: `brew install llvm@23`, then `export PATH="$(brew --prefix llvm@23)/bin:$PATH"`.
- The CI macOS machines do the same through Homebrew: `brewPackages = cmake ninja nasm pkg-config golang ccache` (spec.ts 568) and `brew install --formula llvm@23`, keg added to PATH (spec.ts 1034-1050).

What `stacks-build.yml` does: Linux follows the CI recipe (release tarball + sha256 +
libicu70, `/opt/llvm/bin` on PATH), reading version, sha256 and the ICU deb from
the tag's `pins` by importing `spec.ts` with the bootstrap bun. macOS uses
`brew install llvm@<major>`. Rust is installed with whatever rustup the runner
has, minimal profile plus rust-src only.

## 2. Command sequence, output location, memory controls

- Entry point: `bun scripts/build.ts --profile=release` (package.json line 43).
  Upstream CI runs `node scripts/build.ts --profile=ci-build --os=<os>
  --arch=<arch> [--abi=gnu] [--canary=off]` (`.buildkite/ci.ts` 576-608). The
  `build:ci` script in package.json line 44 is the same thing spelled with flags.
- Output: `build/release/bun-profile` (linked, with symbols) and
  `build/release/bun` (stripped). contributing.mdx 215-223; config.ts 1636-1672
  (`computeBuildDirName`, `bunExeName`, `shouldStrip`); bun.ts 747-779.
  On macOS the default targets also produce `bun-profile.dSYM`
  (configure.ts 526-528).
- **Canary defaults ON** (config.ts 848). Upstream passes `--canary=off` for
  releases (ci.ts 590-594). Without it `bun --version` is not `1.4.4`.
- **LTO**: on by default for release without assertions or ASan (config.ts
  997-1007). Off with `--lto=off` (build.ts 440, 687; profiles.ts 129-137).
  It also selects the WebKit prebuilt: `bun-webkit-<os>-<arch>-lto.tar.gz` vs
  the plain one (deps/webkit.ts 57-84). There is no separate non-LTO release
  profile to prefer: `release-local` needs a local WebKit build, and the old
  `ci-release`/`btg` profiles are retired (profiles.ts 183-187).
- **Job count**: `-j<N>` passes straight to ninja (build.ts 527-537). C/C++
  compiles are also capped by a ninja pool at the core count (compile.ts 46-47);
  ninja's default `-j` is cores+2. rustc runs with `-Zthreads=8` outside
  `--ci=on` (rust.ts 331-349) and counts as one ninja job. Cargo's release
  profile is `codegen-units = 1`, `lto = "off"` (Cargo.toml 152-157).
- **Splitting**: not across machines at this tag (see the corrections above), but
  within one build directory `--target=<name>` builds one ninja target:
  `bun-rust` (all crates' rlibs), `rust-plan`, `check`, any dep by name, and
  `bun` (scripts/build/CLAUDE.md 121; rust.ts 747-754, 809; bun.ts 514, 528).
  On a fresh tree `--target=bun-rust` first builds the cargo plan, reconfigures,
  and restarts with the per-crate graph (rust.ts 749-756). `stacks-build.yml` uses this
  to run configure, Rust, then C++ plus link as three steps.
- Other levers that exist but `stacks-build.yml` does not use: `--unified-sources=off`
  (smaller C++ translation units, more of them; config.ts 1332) and
  `--configure-only`, `--timings` (build.ts 547-560).
- No flag reaches lld's ThinLTO parallelism or adds linker flags from the
  environment; `grep process.env` over flags.ts, compile.ts and bun.ts finds nothing.

## 3. Bootstrap bun

Yes. `bun scripts/build.ts` runs the build, bun runs the code generators and
`bun install`, and every rustc edge is launched through bun
(scripts/build/CLAUDE.md 305-318). `findBun()` looks in `~/.bun/bin` first, then
uses the running bun, then PATH (tools.ts 116-138). The pinned version is
**1.4.2** with per-platform sha256 (spec.ts 130-143); the exact match is only
enforced on Buildkite. contributing.mdx 55-61 only says "a release build of Bun".
Node 25+ can run configure instead (configure.ts 86-92; CI uses Node 26.3.0), but
bun is still needed for the `codegen_bun` rules and rustc edges.

## 4. Packaging and post-build verification

- `packageAndUpload()` in `scripts/build/ci.ts` 294-363, layout comment 239-271,
  `computeBunTriplet()` 278-285, `makeZip()` 378-411. It returns immediately
  unless `BUILDKITE=true` (line 295) and is only called when `cfg.buildkite`
  (build.ts 202-204).
- Two zips per plain release target, both written with
  `cmake -E tar cfv <name>.zip --format=zip <name>` in the build directory:
  - `bun-<os>-<arch>.zip` containing `bun-<os>-<arch>/bun` (stripped).
  - `bun-<os>-<arch>-profile.zip` containing `bun-profile`, `features.json`,
    `testFFI`, the linker map, `linker.order`, and `bun-profile.dSYM` on macOS.
- Triplet is `bun-${os}-${arch}` plus `-musl` or `-android`; x64 has no
  `-baseline` suffix because x64 is always baseline (ci.ts 282-284; config.ts
  1049). The `-baseline` names on the release are re-zipped aliases
  (`.buildkite/scripts/upload-release.sh` 335-360).
- Verification runs inside the build as validations of the link edge
  (bun.ts 516-534; scripts/build/CLAUDE.md 178):
  - `<exe> --revision` smoke test (bun.ts 702-735).
  - `scripts/build/verify-binary.ts binary <spec.json>`: exports, NEEDED
    libraries, symbol-version ceilings, forbidden imports, static initializers,
    hardening bits, debug info, against `scripts/build/binary-expectations.ts`.
    Linux gnu expects NEEDED = libc/libdl/libm/libpthread/ld-linux and a
    `GLIBC_2.17` ceiling (binary-expectations.ts 404-416).
  - `verify-binary.ts duplicates`: no symbol strongly defined twice.
  - The two scans only **fail** the build under `--ci=on`; otherwise they run
    with `--warn-only` (bun.ts 583-591). `stacks-build.yml` does not pass `--ci=on`.
- Note the brief's path `scripts/verify-binary.ts` does not exist; it is
  `scripts/build/verify-binary.ts`.

`stacks-build.yml` reproduces only the stripped zip.

## 5. What could stop a fork

Nothing found that blocks a build. Every download is public: GitHub releases of
`oven-sh/WebKit`, `oven-sh/ninja`, `oven-sh/bun` and `llvm/llvm-project`, GitHub
source archives for the vendored deps, `nodejs.org` (headers), crates.io, the npm
registry. Things that behave differently off Buildkite:

| Item | Effect on a fork | Where |
|---|---|---|
| `GITHUB_SHA` is read as the revision | `bun --revision` would report the fork's workflow commit. `stacks-build.yml` unsets it and sets `GIT_SHA` to the Bun checkout's HEAD | config.ts 1607-1612 |
| `CI=true` / `GITHUB_ACTIONS=true` select build.ts's CI path | Environment dump, repository lookups, piped ninja. No Buildkite calls, but untested by upstream for builds. `stacks-build.yml` unsets both for the build command | scripts/buildkite.ts 29-31; build.ts 160-204 |
| Symbol order file | Inherited from earlier main-branch Buildkite builds via `buildkite-agent`; off Buildkite the link uses an empty placeholder. Binary is correct, startup RSS is not upstream's | ci.ts 430-481, 616-663; configure.ts 546-548; profiles.ts 129-133 |
| glibc sysroot | Absent, so the Linux binary links against the runner's glibc and will need a newer glibc than upstream's 2.17 floor. The check only warns. To ship, provision the sysroot (recipe in spec.ts 1238-1301, all public sources) and set `LINUX_GLIBC_SYSROOT` or `--linux-sysroot` | config.ts 592-601, 1160-1196 |
| Prefetch cache `/opt/bun-prefetch` | Image-baked dependency cache; absent means the build downloads | download.ts 83-95 |
| `buncistore.blob.core.windows.net` | Private-ish mirror, used only for Windows image tools (nssm, Intel SDE) | spec.ts 588, 1804, 1973 |
| Secrets | Only the release upload: `GITHUB_TOKEN`, AWS/R2, Sentry, webhook | upload-release.sh 38-54, 268 |
| Code signing | Windows only (DigiCert, separate step). macOS zips are not notarized; arm64 gets an ad-hoc signature with `entitlements.plist` embedded by `macho-postlink` in the cross build | ci.ts 1037-1067; shims.ts 20-58; flags.ts 1115-1125 |
| macOS SDK via `xmac` | Only for the Linux-hosted cross build; a native macOS build uses the runner's Xcode | macos-sdk.ts; config.ts 1245-1254 |
| Deployment target | 13.0 only under `--ci=on`; a local build targets the SDK's major. `stacks-build.yml` passes `--osx-deployment-target=13.0` | config.ts 1409, 1474-1480, 1253 |

## Could not determine

- Peak memory and wall time of any phase. No file states them; the only evidence
  is the instance types upstream chose.
- Whether LLVM's 23.1.1 Linux x64 release binaries run on the Ubuntu runner with
  only libicu70 added. Upstream runs them on Debian 13 arm64. The install step
  runs `clang --version` and `ld.lld --version` so this fails fast.
- Whether Homebrew currently has `llvm@23`, and at which patch release.
- Whether LLVM 23 clang, macos-15's default Xcode SDK, and a WebKit prebuilt that
  upstream built against SDK 26.5 link together cleanly. Upstream has no native
  macOS build lane to prove it.
- Whether upstream ever codesigns a native macOS build. The `codesign` call in
  the packaging step is modelled on the cross build's embedded entitlements.
- Download and build-directory sizes (LLVM tarball, WebKit prebuilt, `build/`).
  contributing.mdx line 6 says ~10 GB for repository plus build artifacts.
- What `ubuntu-latest` resolves to today, whether `/mnt` exists on it, and how
  much disk the cleanup frees.
- Whether moving major tags `actions/checkout@v7` and
  `actions/upload-artifact@v7` exist. Upstream pins both by commit with the
  comment `# v7.0.1` (.github/workflows/lint.yml 19, vscode-release.yml 56).
- Not read in full: `scripts/build/source.ts`, `codegen.ts`, `rust/*.ts`,
  `macos-sdk.ts`, most of `flags.ts`. A requirement stated only there is missed.

## Guessed rather than read (in `stacks-build.yml`)

- The disk-cleanup directory lists and the swap sizing and placement.
- Dropping `golang`, `ccache` and (macOS) `nasm` from the package lists. Nothing
  in `scripts/build/*.ts` or `deps/*.ts` looks up go or ruby, and every vendored
  dep is a `direct` build, but codegen scripts under `src/` were not read.
- `ulimit -n 16384`, `-j4` on Linux and `-j3` on macOS.
- `--target=bun` on macOS to skip dsymutil. The target name is the stripped
  output's path relative to the build directory, inferred from configure.ts 526.
- The macOS `codesign --entitlements` step (see above).
- The toolchain sanity compile; it approximates bun's static libstdc++ link.
- The hard-coded LLVM program list and Ubuntu mirror URLs are copied from
  spec.ts 586-613 because those constants are not exported.

## Estimate: can a 4 vCPU / 16 GB runner finish?

These are judgments from the build's shape, not measurements.

- **linux-x64, `lto: false`: plausible, roughly even odds.** Step most likely
  to fail: **`link bun-profile`** inside "Build C++, link, strip and check". Even
  with `--lto=off`, lld runs ThinLTO over std plus every Rust crate, each a
  single module (`codegen-units = 1`), and `bun_runtime` is one very large
  module whose backend cannot be split. With `--lto=off` the C++ objects also
  carry full debug info (`-g`, flags.ts 323-324) that lld must read. Upstream
  ran this phase on memory-optimised machines even before the lanes merged
  ("r8g.2xlarge (cargo + ThinLTO link)", 64 GB, ci.ts 507). 16 GB plus 20-28 GB
  of swap may get through, slowly. Second most likely: the single rustc for
  `bun_runtime` in "Build the Rust crates", or the 350-minute limit (upstream
  budgets 60 minutes on 16 faster cores, so 4-6x that before any swapping).
- **linux-x64, `lto: true`: unlikely.** The same link additionally takes all of
  bun's C++ and JavaScriptCore as bitcode in one ThinLTO graph. Upstream gives it
  128 GB.
- **darwin-aarch64 on `macos-15` (3 vCPU, 7 GB): unlikely either way.** Same
  link, through Apple's ld running clang's libLTO in-process (flags.ts
  1540-1547), with less than half the RAM, no swap control, a small disk, and a
  toolchain combination upstream does not exercise. Expect failure in the Rust
  step or the link, or a compatibility error at configure or link time.

If Linux fails at the link: the alternatives that stay on hosted hardware are a
larger runner, or doing what upstream does and cross-compiling darwin-aarch64
from the Linux job (which removes the 7 GB macOS runner from the picture but
needs the `xmac` SDK fetch and its Apple licence acceptance). The diagnostics
artifact (`memory.log`, `timings.html`) and the OOM report step are there to
show which phase hit the ceiling and by how much.
