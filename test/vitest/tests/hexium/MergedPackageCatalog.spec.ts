import {describe, expect, it} from 'vitest';
import {compareCatalogVersions, mergePackageCatalogs} from '../../../../src/r2mm/manager/MergedPackageCatalog';

import {listing} from './fixtures';

describe('merged Valheim catalog', () => {
    it('keeps packages exclusive to either source', () => {
        expect(mergePackageCatalogs([listing('ts', ['1.0.0'], 'TsOnly')], [listing('hex', ['1.0.0'], 'HexOnly')])
            .map(pkg => pkg.full_name)).toEqual(['Team-TsOnly', 'Team-HexOnly']);
    });

    it('merges the complete history, sorts numerically and uses Hexium only for ties', () => {
        const [pkg] = mergePackageCatalogs([listing('ts', ['1.4.0', '1.2.0', '1.0.0'])], [listing('hex', ['1.3.0', '1.2.0'])]);
        expect(pkg!.versions.map(v => v.version_number)).toEqual(['1.4.0', '1.3.0', '1.2.0', '1.0.0']);
        expect(pkg!.versions.map(v => v.description)).toEqual(['ts 1.4.0', 'hex 1.3.0', 'hex 1.2.0', 'ts 1.0.0']);
        expect(pkg!.package_url).toContain('thunderstore.io');
    });

    it('recognizes 2.4.13 as newer than 2.4.8', () => {
        const [pkg] = mergePackageCatalogs([listing('ts', ['2.4.8'])], [listing('hex', ['2.4.13'])]);
        expect(pkg!.versions[0]!.version_number).toBe('2.4.13');
        expect(pkg!.package_url).toContain('hexium.gg');
        expect(compareCatalogVersions('10.0.0', '9.99.99')).toBeGreaterThan(0);
    });

    it('chooses the complete Hexium release record without borrowing dependencies or size', () => {
        const hex = listing('hex', ['1.0.0']);
        hex.versions[0]!.file_size = 2048;
        hex.versions[0]!.dependencies = ['HexOnly-Library-3.0.0'];
        const [pkg] = mergePackageCatalogs([listing('ts', ['1.0.0'])], [hex]);
        expect(pkg!.versions[0]!.dependencies).toEqual(['HexOnly-Library-3.0.0']);
        expect(pkg!.versions[0]!.file_size).toBe(2048);
        expect(pkg!.versions[0]!.download_url).toContain('hexium.gg');
        expect(pkg!.package_url).toContain('hexium.gg');
    });

    it.each([undefined, null, '100', '', false, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid file_size %s with source and release context', value => {
            for (const source of ['ts', 'hex'] as const) {
                const bad = listing(source, ['1.0.0']);
                (bad.versions[0] as Record<string, unknown>).file_size = value;
                const merge = () => source === 'hex'
                    ? mergePackageCatalogs([listing('ts', ['1.0.0'])], [bad])
                    : mergePackageCatalogs([bad], []);
                expect(merge).toThrow(`Invalid file_size for Team-Mod-1.0.0 from ${source === 'hex' ? 'hexium' : 'thunderstore'}`);
            }
        }
    );

    it('rejects a missing size instead of substituting zero or the other source size', () => {
        const hex = listing('hex', ['1.0.0']);
        delete (hex.versions[0] as {file_size?: number}).file_size;
        expect(() => mergePackageCatalogs([listing('ts', ['1.0.0'])], [hex])).toThrow('file_size');
    });

    it('does not require a size for a withdrawn release', () => {
        const hex = listing('hex', ['2.0.0', '1.0.0']);
        hex.versions[0]!.is_active = false;
        delete (hex.versions[0] as {file_size?: number}).file_size;
        expect(mergePackageCatalogs([], [hex])[0]!.versions.map(v => v.version_number)).toEqual(['1.0.0']);
    });

    it('preserves categories needed for exact modpack dependencies', () => {
        const ts = {...listing('ts', ['1.0.0']), categories: ['Modpacks', 'Tools'], is_deprecated: true};
        const hex = {...listing('hex', ['2.0.0']), categories: ['Tools', 'Server'], has_nsfw_content: true};
        const [pkg] = mergePackageCatalogs([ts], [hex]);
        expect(pkg!.categories).toEqual(['Modpacks', 'Tools', 'Server']);
        expect(pkg!.is_deprecated).toBe(false);
        expect(pkg!.has_nsfw_content).toBe(true);
    });

    it('keeps deprecation when all available listings are deprecated', () => {
        const ts = {...listing('ts', ['1.0.0']), is_deprecated: true};
        const hex = {...listing('hex', ['2.0.0']), is_deprecated: true};
        expect(mergePackageCatalogs([ts], [hex])[0]!.is_deprecated).toBe(true);
        expect(mergePackageCatalogs([], [hex])[0]!.is_deprecated).toBe(true);
    });

    it('does not merge different owners with the same mod name', () => {
        expect(mergePackageCatalogs([listing('ts', ['1.0.0'], 'Mod', 'First')], [listing('hex', ['2.0.0'], 'Mod', 'Second')])).toHaveLength(2);
    });

    it('supports legacy owners containing hyphens', () => {
        expect(mergePackageCatalogs([], [listing('hex', ['1.0.0'], 'Mod', 'Legacy-Team')])[0]!.full_name).toBe('Legacy-Team-Mod');
    });

    it('does not mutate either input', () => {
        const ts = [listing('ts', ['1.0.0', '2.0.0'])];
        const hex = [listing('hex', ['1.0.0'])];
        const before = JSON.stringify({ts, hex});
        mergePackageCatalogs(ts, hex);
        expect(JSON.stringify({ts, hex})).toBe(before);
    });

    it('ignores inactive versions and packages without active versions', () => {
        const hex = listing('hex', ['3.0.0', '1.0.0']);
        hex.versions[0]!.is_active = false;
        const empty = listing('hex', ['4.0.0'], 'Withdrawn');
        empty.versions[0]!.is_active = false;
        const result = mergePackageCatalogs([listing('ts', ['2.0.0'])], [hex, empty]);
        expect(result).toHaveLength(1);
        expect(result[0]!.versions.map(v => v.version_number)).toEqual(['2.0.0', '1.0.0']);
    });

    it('applies exclusions to both sources', () => {
        expect(mergePackageCatalogs([listing('ts', ['1.0.0'])], [listing('hex', ['2.0.0'])], new Set(['Team-Mod']))).toEqual([]);
    });

    it.each(['2.4.13-beta', '1.2', '-1.0.0', '9007199254740992.0.0'])('rejects malformed or unsupported version %s', number => {
        expect(() => mergePackageCatalogs([], [listing('hex', [number])])).toThrow('Invalid catalog version');
    });

    it('rejects invalid dependencies instead of silently dropping them', () => {
        const bad = listing('hex', ['1.0.0']);
        (bad.versions[0] as Record<string, unknown>).dependencies = null;
        expect(() => mergePackageCatalogs([], [bad])).toThrow('dependencies');
    });

    it('rejects path traversal in package identity', () => {
        expect(() => mergePackageCatalogs([], [listing('hex', ['1.0.0'], '../Mod')])).toThrow('package identity');
    });

    it('rejects non-HTTPS artifact URLs', () => {
        const bad = listing('hex', ['1.0.0']);
        bad.versions[0]!.download_url = 'file:///tmp/mod.zip';
        expect(() => mergePackageCatalogs([], [bad])).toThrow('HTTPS');
    });

    it('rejects non-array catalogs and duplicate packages', () => {
        expect(() => mergePackageCatalogs([], {results: []})).toThrow('expected an array');
        expect(() => mergePackageCatalogs([], [listing('hex', ['1.0.0']), listing('hex', ['2.0.0'])])).toThrow('Duplicate package');
    });

    it('rejects duplicate versions within a source', () => {
        expect(() => mergePackageCatalogs([], [listing('hex', ['1.0.0', '1.0.0'])])).toThrow('Duplicate version');
    });
});
