import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createStore} from 'vuex';
import type {State as RootState} from '../../../../src/store';
import type Game from '../../../../src/model/game/Game';
import type {CatalogPackage} from '../../../../src/r2mm/manager/MergedPackageCatalog';

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(), merged: vi.fn(), replace: vi.fn(), upsert: vi.fn(), prune: vi.fn(),
    timestamp: vi.fn(), latest: vi.fn(), packages: vi.fn(), setHash: vi.fn(), reset: vi.fn(),
    profileRead: vi.fn(),
}));
vi.mock('../../../../src/utils/HttpUtils', () => ({
    fetchAndProcessBlobFile: mocks.fetch, isNetworkError: () => false, getAxiosWithTimeouts: vi.fn(),
}));
vi.mock('../../../../src/utils/Common', () => ({retry: (operation: () => unknown) => operation()}));
vi.mock('../../../../src/r2mm/manager/FetchMergedPackageCatalog', () => ({fetchMergedPackageCatalog: mocks.merged}));
vi.mock('../../../../src/r2mm/manager/PackageDexieStore', () => ({
    replacePackageList: mocks.replace, upsertPackageListChunk: mocks.upsert, pruneRemovedMods: mocks.prune,
    getLastPackageListUpdateTime: mocks.timestamp, isLatestPackageListIndex: mocks.latest,
    getPackagesAsThunderstoreMods: mocks.packages, setLatestPackageListIndex: mocks.setHash, resetCommunity: mocks.reset,
}));
vi.mock('../../../../src/r2mm/mods/ProfileModList', () => ({default: {getModList: mocks.profileRead}}));
vi.mock('../../../../src/providers/generic/connection/CdnProvider', () => ({default: {
    addCdnQueryParameter: (url: string) => url, replaceCdnHost: (url: string) => url,
}}));
vi.mock('../../../../src/providers/cdn/PackageUrlTransformer', () => ({transformPackageUrl: (url: string) => url}));
vi.mock('../../../../src/utils/Deprecations', () => ({Deprecations: {getDeprecatedPackageMap: () => new Map()}}));

import {TsModsModule} from '../../../../src/store/modules/TsModsModule';
import {SplashModule} from '../../../../src/store/modules/SplashModule';
import {
    assertCurrentCatalogRefresh, captureCatalogRefresh, invalidateCatalogRefresh, isCurrentCatalogRefresh,
} from '../../../../src/r2mm/manager/CatalogRefresh';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

const valheim = {internalFolderName: 'Valheim', displayName: 'Valheim', thunderstoreUrl: 'https://thunderstore.io/valheim/index'} as Game;
const otherGame = {internalFolderName: 'RiskOfRain2', displayName: 'Risk of Rain 2', thunderstoreUrl: 'https://thunderstore.io/ror2/index'} as Game;
const index = {content: ['https://thunderstore.io/chunk'], hash: 'index-hash'};

function makeStore(game = valheim) {
    const store = createStore<RootState>({
        strict: true,
        state: {activeGame: game} as RootState,
        mutations: {
            setActiveGame(state, next: Game) {
                // The root game's mutation invalidates the generation synchronously.
                invalidateCatalogRefresh(state.tsMods);
                state.activeGame = next;
            },
            setProfile(state, profile) { state.profile.activeProfile = profile; },
        },
        modules: {
            tsMods: TsModsModule,
            splash: SplashModule,
            download: {namespaced: true, getters: {activeDownloadCount: () => 0}},
            profile: {
                namespaced: true,
                state: () => ({activeProfile: null, modList: []}),
                mutations: {setModList(state, mods) { state.modList = mods; }},
                actions: {updateModList({commit}, mods) { commit('setModList', mods); }},
            },
        },
    });
    store.commit('splash/initialiseRequests');
    return store;
}

beforeEach(() => {
    vi.resetAllMocks();
    mocks.fetch.mockResolvedValue(index);
    mocks.merged.mockResolvedValue([]);
    mocks.packages.mockResolvedValue([]);
    mocks.timestamp.mockResolvedValue(new Date('2026-09-18T00:00:00Z'));
    mocks.latest.mockResolvedValue(false);
    mocks.replace.mockImplementation(async (_community, _packages, _hash, check) => check());
    mocks.upsert.mockImplementation(async (_community, _packages, check) => check());
    mocks.prune.mockImplementation(async (_community, _names, check) => check());
    mocks.setHash.mockImplementation(async (_community, _hash, check) => check());
    mocks.reset.mockImplementation(async (_community, check) => check());
    mocks.profileRead.mockResolvedValue([]);
});

describe('catalog refresh ownership', () => {
    it('invalidates a request when switching away and back to the same Game instance', () => {
        const store = makeStore();
        store.commit('tsMods/startThunderstoreModListUpdate');
        const request = captureCatalogRefresh(store.state);
        store.commit('setActiveGame', otherGame);
        store.commit('setActiveGame', valheim);
        expect(store.state.activeGame.internalFolderName).toBe(request.community);
        expect(isCurrentCatalogRefresh(store.state, request)).toBe(false);
        expect(() => assertCurrentCatalogRefresh(store.state, request)).toThrow('superseded');
        expect(store.state.tsMods.isThunderstoreModListUpdateInProgress).toBe(false);
    });

    it('never resets the generation when clearing the local state', () => {
        const store = makeStore();
        store.commit('tsMods/startThunderstoreModListUpdate');
        const request = captureCatalogRefresh(store.state);
        store.commit('tsMods/reset');
        store.commit('tsMods/startThunderstoreModListUpdate');
        expect(store.state.tsMods.catalogGeneration).toBeGreaterThan(request.generation);
        store.commit('tsMods/finishThunderstoreModListUpdate', request);
        expect(store.state.tsMods.isThunderstoreModListUpdateInProgress).toBe(true);
    });

    it.each(['resolve', 'reject'] as const)('does not let a stale index %s unlock or overwrite a new refresh', async outcome => {
        const store = makeStore();
        const oldIndex = deferred<typeof index>();
        const newIndex = deferred<typeof index>();
        mocks.fetch.mockReturnValueOnce(oldIndex.promise).mockReturnValueOnce(newIndex.promise);
        const oldRun = store.dispatch('tsMods/syncPackageList');
        store.commit('setActiveGame', otherGame);
        const newRun = store.dispatch('tsMods/syncPackageList');
        const status = store.state.tsMods.thunderstoreModListUpdateStatus;
        if (outcome === 'resolve') oldIndex.resolve(index);
        else oldIndex.reject(new Error('Old HTTP error'));
        await oldRun;
        expect(store.state.tsMods.isThunderstoreModListUpdateInProgress).toBe(true);
        expect(store.state.tsMods.thunderstoreModListUpdateStatus).toBe(status);
        expect(store.state.tsMods.thunderstoreModListUpdateError).toBeUndefined();
        expect(mocks.replace).not.toHaveBeenCalled();
        mocks.latest.mockResolvedValue(true);
        newIndex.resolve(index);
        await newRun;
        expect(store.state.tsMods.isThunderstoreModListUpdateInProgress).toBe(false);
        expect(mocks.setHash.mock.calls[0]![0]).toBe('RiskOfRain2');
    });

    it('discards an old merged snapshot and progress after a newer Valheim refresh completes', async () => {
        const store = makeStore();
        const oldCatalog = deferred<CatalogPackage[]>();
        mocks.merged.mockReturnValueOnce(oldCatalog.promise);
        const oldRun = store.dispatch('tsMods/syncPackageList');
        await vi.waitFor(() => expect(mocks.merged).toHaveBeenCalledTimes(1));
        const reportOldProgress = mocks.merged.mock.calls[0]![2];
        store.commit('setActiveGame', otherGame);
        store.commit('setActiveGame', valheim);
        await store.dispatch('tsMods/syncPackageList');
        expect(mocks.replace).toHaveBeenCalledTimes(1);
        reportOldProgress(45);
        oldCatalog.resolve([]);
        await oldRun;
        expect(mocks.replace).toHaveBeenCalledTimes(1);
        expect(store.state.tsMods.thunderstoreModListUpdateStatus).toBe('');
        expect(store.state.tsMods.thunderstoreModListUpdateError).toBeUndefined();
    });

    it('supplies a guard that rejects a transaction deferred until after a game switch', async () => {
        const store = makeStore();
        const transaction = deferred<void>();
        let published = false;
        mocks.replace.mockImplementationOnce(async (_community, _packages, _hash, check) => {
            await transaction.promise;
            check();
            published = true;
        });
        const run = store.dispatch('tsMods/syncPackageList');
        await vi.waitFor(() => expect(mocks.replace).toHaveBeenCalledTimes(1));
        store.commit('setActiveGame', otherGame);
        transaction.resolve();
        await run;
        expect(published).toBe(false);
        expect(store.state.tsMods.thunderstoreModListUpdateError).toBeUndefined();
    });

    it('does not write a non-Valheim chunk into the newly selected community', async () => {
        const store = makeStore(otherGame);
        const chunk = deferred<{content: {full_name: string}[]}>();
        mocks.fetch.mockResolvedValueOnce(index).mockReturnValueOnce(chunk.promise);
        const run = store.dispatch('tsMods/syncPackageList');
        await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
        store.commit('setActiveGame', valheim);
        chunk.resolve({content: [{full_name: 'Team-Mod'}]});
        await run;
        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(mocks.prune).not.toHaveBeenCalled();
        expect(mocks.setHash).not.toHaveBeenCalled();
    });

    it('does not publish an obsolete mod-list read or start its timestamp read', async () => {
        const store = makeStore();
        const packages = deferred<never[]>();
        mocks.packages.mockReturnValueOnce(packages.promise);
        const run = store.dispatch('tsMods/syncPackageList');
        await vi.waitFor(() => expect(mocks.packages).toHaveBeenCalledTimes(1));
        store.commit('setActiveGame', otherGame);
        packages.resolve([]);
        await run;
        expect(mocks.timestamp).not.toHaveBeenCalled();
        expect(store.state.tsMods.mods).toEqual([]);
    });

    it('does not publish an obsolete timestamp', async () => {
        const store = makeStore();
        const timestamp = deferred<Date>();
        mocks.timestamp.mockReturnValueOnce(timestamp.promise);
        const run = store.dispatch('tsMods/syncPackageList');
        await vi.waitFor(() => expect(mocks.timestamp).toHaveBeenCalledTimes(1));
        store.commit('setActiveGame', otherGame);
        timestamp.resolve(new Date());
        await run;
        expect(store.state.tsMods.modsLastUpdated).toBeUndefined();
    });

    it('does not publish a profile read from an obsolete catalog refresh', async () => {
        const store = makeStore();
        store.commit('setProfile', {asImmutableProfile: () => ({})});
        const profile = deferred<unknown[]>();
        mocks.profileRead.mockReturnValueOnce(profile.promise);
        const run = store.dispatch('tsMods/syncPackageList');
        await vi.waitFor(() => expect(mocks.profileRead).toHaveBeenCalledTimes(1));
        store.commit('setActiveGame', otherGame);
        profile.resolve([{name: 'Old-Mod'}]);
        await run;
        expect(store.state.profile.modList).toEqual([]);
    });

    it('does not let an obsolete cache reset clear the new operation flag', async () => {
        const store = makeStore();
        const reset = deferred<void>();
        mocks.reset.mockReturnValueOnce(reset.promise);
        const oldRun = store.dispatch('tsMods/resetActiveGameCache');
        store.commit('setActiveGame', otherGame);
        const pending = deferred<typeof index>();
        mocks.fetch.mockReturnValueOnce(pending.promise);
        const newRun = store.dispatch('tsMods/syncPackageList');
        reset.resolve();
        await oldRun;
        expect(store.state.tsMods.isThunderstoreModListUpdateInProgress).toBe(true);
        mocks.latest.mockResolvedValue(true);
        pending.resolve(index);
        await newRun;
    });

    it('keeps a current refresh error visible and unlocks only its own operation', async () => {
        const store = makeStore();
        mocks.merged.mockRejectedValueOnce(new Error('Invalid file_size for Team-Mod-1.0.0 from hexium'));
        await store.dispatch('tsMods/syncPackageList');
        expect(mocks.replace).not.toHaveBeenCalled();
        expect(store.state.tsMods.thunderstoreModListUpdateError?.message).toContain('Invalid file_size');
        expect(store.state.tsMods.isThunderstoreModListUpdateInProgress).toBe(false);
    });
});

describe('splash refresh ownership', () => {
    it.each(['resolve', 'reject'] as const)('ignores a stale splash index %s, including error, progress and finalization', async outcome => {
        const store = makeStore();
        mocks.timestamp.mockResolvedValue(undefined);
        const oldIndex = deferred<typeof index>();
        const newIndex = deferred<typeof index>();
        mocks.fetch.mockReturnValueOnce(oldIndex.promise).mockReturnValueOnce(newIndex.promise);
        const oldRun = store.dispatch('splash/getThunderstoreMods');
        await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
        store.commit('setActiveGame', otherGame);
        store.commit('splash/initialiseRequests');
        const newRun = store.dispatch('splash/getThunderstoreMods');
        await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
        if (outcome === 'resolve') oldIndex.resolve(index);
        else oldIndex.reject(new Error('Old splash error'));
        expect(await oldRun).toBe(false);
        expect(store.state.tsMods.isThunderstoreModListUpdateInProgress).toBe(true);
        expect(store.state.tsMods.thunderstoreModListUpdateError).toBeUndefined();
        expect(store.state.splash.requests.find(item => item.getName() === 'PackageListIndex')!.getProgress()).toBe(0);
        mocks.fetch.mockResolvedValue({content: []});
        newIndex.resolve(index);
        expect(await newRun).toBe(true);
        expect(store.state.tsMods.isThunderstoreModListUpdateInProgress).toBe(false);
    });

    it('does not start a background refresh after an obsolete cached splash read', async () => {
        const store = makeStore();
        const packages = deferred<never[]>();
        mocks.packages.mockReturnValueOnce(packages.promise);
        const run = store.dispatch('splash/getThunderstoreMods');
        await vi.waitFor(() => expect(mocks.packages).toHaveBeenCalledTimes(1));
        store.commit('setActiveGame', otherGame);
        packages.resolve([]);
        expect(await run).toBe(false);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('loads the existing cache before scheduling the current game background refresh', async () => {
        const store = makeStore();
        const fetched = deferred<typeof index>();
        mocks.fetch.mockReturnValueOnce(fetched.promise);
        expect(await store.dispatch('splash/getThunderstoreMods')).toBe(true);
        expect(mocks.packages).toHaveBeenCalledTimes(1);
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(store.state.tsMods.isThunderstoreModListUpdateInProgress).toBe(true);
        fetched.resolve(index);
        await vi.waitFor(() => expect(store.state.tsMods.isThunderstoreModListUpdateInProgress).toBe(false));
    });
});
