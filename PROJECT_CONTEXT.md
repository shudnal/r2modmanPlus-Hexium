# r2modmanPlus-Hexium project context

## Scope

This fork is maintained for local use, initially for Valheim only. Work against
`develop` in a separate feature branch and open pull requests in
`shudnal/r2modmanPlus-Hexium`, not in upstream r2modman.

## Catalog contract

- Merge the complete Thunderstore and Hexium version histories by `full_name`.
- Select the highest numeric `major.minor.patch` version regardless of source.
- For an identical version, prefer the complete Hexium release record.
- Reuse the existing name/version artifact cache regardless of provenance.
- Do not compare, hash, repack, or deduplicate archives by their contents.
- Keep exact old versions for dependencies and profile import.
- Keep the existing profile format, package keys, installation and launch logic.
- Do not add accounts, publishing, source selection, Hexium deep links, or
  per-source offline recovery. Both repositories are expected to be available.
- A failed combined refresh must not publish an incomplete replacement catalog.
- Do not allow automatic upstream application updates to overwrite this build.

All project code, comments, documentation and review messages must be in English.
See [Hexium integration](docs/Hexium.md) for implementation and verification notes.
