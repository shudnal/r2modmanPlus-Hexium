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
Switching away from the captured game prevents publishing the result into the
new game's catalog or mod list.

The adapter follows the Hexium OpenAPI supplied with the implementation request.
Live Hexium responses and downloads still need verification in the local manager.
The schema does not require `file_size`; absent or invalid sizes normalize to zero
(unknown). Download-size totals are therefore estimates and can exclude packages
whose size is not reported. Download completion is determined by the existing
transfer/extraction status, not by that estimate.

## Local build

Keep the upstream package name, application identity and profile format. There
is no public release pipeline for this change and no new version number.
The `update-app` IPC handler is intentionally disabled: installing an automatic
upstream update would remove the Hexium changes. Update this fork manually.

Use the environment and dependency setup described in `BUILDING.md` and
`DevEnvSetup.md`. Existing commands include:

```sh
pnpm install --frozen-lockfile
pnpm dev
# Alternatively, build the local Windows application:
pnpm build-win
```

Back up existing profiles before trying the build. Do not run the upstream manager
and this build against the same data directory concurrently. An upstream catalog
refresh knows only about Thunderstore and can replace the combined online list.
A restart or normal catalog refresh in this build loads both sources again.

## Verification

The focused Vitest specs are in `test/vitest/tests/hexium`:

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

No game assemblies or Valheim mods need to be rebuilt to validate this manager
integration. The supplied API contract is not evidence of a successful live API
or archive-download test; record those results separately after running them.
