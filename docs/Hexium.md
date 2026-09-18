# Local Valheim catalog integration

## Behavior

Valheim uses a single catalog assembled from Thunderstore and Hexium. Other games
retain the existing Thunderstore path. There is no repository selector.

Packages are matched by their exact `full_name`; versions are matched by their
exact `version_number`. Version ordering is numeric, not lexicographic. The highest
available version wins regardless of repository. Equal versions use the entire
Hexium version record, including its URL and dependencies. All older versions are
kept, so exact-version dependency and profile lookups still work.

Package metadata follows the source of the selected newest version. Categories
are combined (including `Modpacks`), the NSFW flag is combined conservatively, and
an available package is deprecated only if all of its usable listings agree.
Inactive releases and packages with no active releases are not offered.

The normal artifact cache is unchanged. An already cached `Owner-Name/1.2.3`
remains usable even if it originally came from Thunderstore and the selected
online record now comes from Hexium. Archive byte equality is deliberately not
required; packaging metadata may differ without changing the mod assembly.
Updating the catalog never installs or downgrades a mod on its own.

## Implementation

- `MergedPackageCatalog.ts` validates and normalizes API records, merges histories,
  and resolves duplicate releases. It does not mutate either input.
- `FetchMergedPackageCatalog.ts` loads every Thunderstore index chunk and the full
  Hexium `/api/v1/package/` response. It does not use the latest-only experimental
  package index.
- `TsModsModule.ts` always refreshes both inputs for Valheim. An unchanged
  Thunderstore index must not suppress a Hexium-only update. The original index
  hash optimization remains enabled for other games.
- `PackageDexieStore.replacePackageList` publishes packages, summaries, removals
  and the refresh timestamp in one transaction after both inputs succeed.
- Source selection does not become part of a profile or cache key. The selected
  records already carry the download URL and package page URL.
- `CdnProvider.ts` only rewrites Thunderstore domains. Hexium URLs, including query
  parameters, are passed through unchanged.
- `PackageMarkdown.ts` preserves the Thunderstore HTML endpoint and uses Hexium's
  versioned Markdown endpoint followed by its Markdown-to-HTML renderer.

There are no separate persisted source snapshots and no cross-repository retry
or failover policy. An unavailable source or malformed response fails the refresh
and retains the previous combined catalog. Source progress uses the existing UI.
Each startup, refresh or cache reset owns a monotonically increasing generation
and captures its community and index URL. Starting another operation, selecting
a game (including a reused Game instance), or resetting local state invalidates
previous work. All continuations, progress/error updates and finalization check
that generation. Database write guards also run inside transactions, so a queued
or interrupted obsolete write is aborted instead of replacing a newer catalog.
Stale startup work returns false and cannot advance the splash screen. Background
profile reads are likewise checked before publishing their installed-mod list.

The adapter follows the supplied Hexium OpenAPI with one observed correction:
the repository owner checked the live V1 catalog and reported `file_size` present
in all 3,405 versions with valid values, despite its omission from PackageListing
in that schema. This is a user-reported API check, not an automated live test here.
Active releases must provide a positive safe-integer byte count. Missing, zero or
invalid sizes fail validation with the source, package and version in the error;
they are never converted to zero or borrowed from the other repository. The
existing byte-based downloader/progress path is unchanged. There is no
unknown-size download mode, and already cached archives are still reused.

## Donation links

Donation links are optional, publisher-controlled metadata, not trusted OS
commands. `DonationUrl.normalizeDonationUrl` accepts only absolute HTTPS URLs
with a hostname and no credentials. Other schemes, relative/malformed URLs,
control characters and backslashes become null. Valid links are canonicalized.
An invalid donation link hides Donate without rejecting the package or changing
which release wins; it is never replaced with the other listing's donation link.

The same policy runs in the catalog normalizer and `ThunderstoreMod` setter.
Both full-package and summary reads therefore protect previously cached links
before any Donate control receives them. Clearing the cache is unnecessary.
This is a donation-field restriction, not a general Electron IPC hardening pass;
Steam validation and Epic game-launch protocols remain unchanged.

## Local build

Keep the upstream package name, application identity and profile format. There
is no public release pipeline for this change and no new version number.
The `update-app` IPC handler is intentionally disabled: installing an automatic
upstream update would remove the Hexium changes. Update this fork manually.

For Windows, use Node.js 22.23.1 x64 (pinned in `mise.toml`) and pnpm 11.8.0
(pinned in `package.json`). Install Git and Node first, then run in PowerShell:

```powershell
npm.cmd install --global pnpm@11.8.0
git clone --branch feature/hexium-catalog --single-branch https://github.com/shudnal/r2modmanPlus-Hexium.git
Set-Location .\r2modmanPlus-Hexium
pnpm.cmd install --frozen-lockfile
pnpm.cmd exec quasar prepare
pnpm.cmd run build-win --publish=never
```

Run each command only after the preceding command succeeds. Do not run
`pnpm upgrade` or remove the lockfile as part of setting up this branch. The old
upstream Python 2 instructions are not an additional prerequisite for this change.
Windows installer and portable outputs are under `dist/electron/Packaged`.
For development instead of packaging, use `pnpm.cmd run dev`.

Back up existing profiles before trying the build. Do not run the upstream manager
and this build against the same data directory concurrently. An upstream catalog
refresh knows only about Thunderstore and can replace the combined online list.
A restart or normal catalog refresh in this build loads both sources again.

## Verification

The focused Vitest specs are in `test/vitest/tests/hexium`. They include size
validation, donation URL filtering (including legacy cache reads), and controlled
out-of-order startup/refresh/reset completions.
Run after installing dependencies and preparing Quasar as shown above:

```sh
pnpm exec vitest run test/vitest/tests/hexium
pnpm typecheck
# The complete upstream suite also needs its generated filesystem fixtures:
node test/folder-structure-testing/populator.mjs
pnpm test
```

Check in the local application:

1. Start with an existing Thunderstore-only cache and confirm Hexium-only packages
   appear after the normal refresh. Confirm a fresh profile also sees both sites.
2. Compare a TS-newer package, a Hexium-newer package and an equal-version package.
   Both individual updates and Update All must select the same newest version.
3. Install a package whose dependency exists only on the other site; then select
   a historical release that is present on just one site.
4. Reuse a previously cached equal version without another download. Restart the
   manager and confirm the merged history and selected package URLs persist.
5. Open README, CHANGELOG and View online for a Hexium-only package and a TS-newer
   package. Confirm the existing launcher and profile contents remain unchanged.
6. Start a refresh, switch games, and switch back while the earlier request is
   pending. Old success/error/progress callbacks must not affect the newer run.
   Repeat with a cold startup and with a cache reset in flight.
7. Confirm valid HTTPS donation links still appear. Using test fixtures rather
   than live malicious links, confirm a non-web donation URL is removed from
   both full-package and summary reads, including a pre-fix cache entry.

No game assemblies or Valheim mods need to be rebuilt to validate this manager
integration. The supplied API contract is not evidence of a successful live API
or archive-download test; record those results separately after running them.
