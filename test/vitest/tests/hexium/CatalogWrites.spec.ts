import {beforeEach, describe, expect, it, vi} from 'vitest';
import {listing} from './fixtures';

// A transactional test double exercises the production write/check ordering.
// Dexie/IndexedDB integration itself still needs the application test environment.
const db = vi.hoisted(() => ({
    rows: {} as Record<string, Record<string, any>[]>,
    current: true,
    cancelAtWrite: 0,
    cancelOnStart: false,
    writes: 0,
}));
vi.mock('dexie', () => {
    function written() {
        if (++db.writes === db.cancelAtWrite) db.current = false;
    }
    class Table {
        constructor(readonly name: string) {}
        where({community}: {community: string}) {
            return {
                delete: async () => {
                    db.rows[this.name] = db.rows[this.name]!.filter(row => row.community !== community);
                    written();
                },
                primaryKeys: async () => db.rows[this.name]!.filter(row => row.community === community)
                    .map(row => [row.community, row.full_name]),
                toArray: async () => db.rows[this.name]!.filter(row => row.community === community),
            };
        }
        async bulkPut(rows: Record<string, any>[]) {
            db.rows[this.name]!.push(...rows);
            written();
        }
        async bulkDelete(keys: string[][]) {
            db.rows[this.name] = db.rows[this.name]!.filter(row => !keys.some(key => key[0] === row.community && key[1] === row.full_name));
            written();
        }
        async put(row: Record<string, any>) {
            db.rows[this.name] = db.rows[this.name]!.filter(old => old.community !== row.community);
            db.rows[this.name]!.push(row);
            written();
        }
    }
    return {default: class {
        packages = new Table('packages');
        summaries = new Table('summaries');
        indexHashes = new Table('indexHashes');
        version() {
            return {stores: () => {
                this.packages = new Table('packages');
                this.summaries = new Table('summaries');
                this.indexHashes = new Table('indexHashes');
            }};
        }
        async transaction(...args: any[]) {
            // Like Dexie, the scope is not run synchronously at the call site.
            await Promise.resolve();
            const snapshot = structuredClone(db.rows);
            if (db.cancelOnStart) db.current = false;
            try { return await args[args.length - 1](); }
            catch (error) { db.rows = snapshot; throw error; }
        }
    }};
});
vi.mock('../../../../src/model/ThunderstoreMod', () => ({default: {parseFromSummary: (value: unknown) => value, defaultOrderComparer: () => 0}}));
vi.mock('../../../../src/model/ThunderstoreCombo', () => ({default: class {}}));
vi.mock('../../../../src/model/ThunderstoreVersion', () => ({default: class {}}));
vi.mock('../../../../src/utils/DependencyUtils', () => ({splitToNameAndVersion: vi.fn()}));
vi.mock('../../../../src/r2mm/manager/PackageDexieStoreMockables', () => ({fetchPackagesByCommunityPackagePairs: vi.fn()}));

import {
    replacePackageList, resetCommunity, pruneRemovedMods, upsertPackageListChunk, setLatestPackageListIndex,
} from '../../../../src/r2mm/manager/PackageDexieStore';

const check = () => { if (!db.current) throw new Error('superseded'); };
const packages = [listing('hex', ['2.0.0'])];
beforeEach(() => {
    db.rows = {
        packages: [{community: 'Valheim', full_name: 'Old-Mod'}, {community: 'Other', full_name: 'Other-Mod'}],
        summaries: [{community: 'Valheim', full_name: 'Old-Mod'}, {community: 'Other', full_name: 'Other-Mod'}],
        indexHashes: [{community: 'Valheim', hash: 'old'}],
    };
    db.current = true;
    db.cancelAtWrite = 0;
    db.cancelOnStart = false;
    db.writes = 0;
});

describe('guarded catalog transactions', () => {
    it('publishes a valid complete replacement without changing another community', async () => {
        await replacePackageList('Valheim', packages, 'new', check);
        expect(db.rows.packages!.map(row => row.full_name)).toEqual(['Other-Mod', 'Team-Mod']);
        expect(db.rows.summaries!.map(row => row.full_name)).toEqual(['Other-Mod', 'Team-Mod']);
        expect(db.rows.indexHashes![0]!.hash).toBe('new');
    });

    it('rejects a request invalidated before the transaction scope starts', async () => {
        db.cancelOnStart = true;
        const before = structuredClone(db.rows);
        await expect(replacePackageList('Valheim', packages, 'new', check)).rejects.toThrow('superseded');
        expect(db.rows).toEqual(before);
        expect(db.writes).toBe(0);
    });

    it.each([1, 2, 3, 4, 5])('rolls back a replacement invalidated after write %s', async write => {
        db.cancelAtWrite = write;
        const before = structuredClone(db.rows);
        await expect(replacePackageList('Valheim', packages, 'new', check)).rejects.toThrow('superseded');
        expect(db.rows).toEqual(before);
    });

    it.each(['reset', 'prune', 'chunk', 'hash'])('guards the %s write path too', async operation => {
        db.cancelAtWrite = 1;
        const before = structuredClone(db.rows);
        const run = () => {
            switch (operation) {
                case 'reset': return resetCommunity('Valheim', check);
                case 'prune': return pruneRemovedMods('Valheim', new Set(), check);
                case 'chunk': return upsertPackageListChunk('Valheim', packages, check);
                default: return setLatestPackageListIndex('Valheim', 'new', check);
            }
        };
        await expect(run()).rejects.toThrow('superseded');
        expect(db.rows).toEqual(before);
    });
});
