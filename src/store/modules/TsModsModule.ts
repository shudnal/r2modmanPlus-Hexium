import { markRaw } from 'vue';
import { ActionTree, GetterTree, MutationTree } from 'vuex';

import { State as RootState } from '../index';
import ManifestV2 from '../../model/ManifestV2';
import R2Error from "../../model/errors/R2Error";
import ThunderstoreMod from '../../model/ThunderstoreMod';
import VersionNumber from '../../model/VersionNumber';
import CdnProvider from '../../providers/generic/connection/CdnProvider';
import * as PackageDb from '../../r2mm/manager/PackageDexieStore';
import ProfileModList from '../../r2mm/mods/ProfileModList';
import { isEmptyArray, isStringArray } from '../../utils/ArrayUtils';
import { retry } from '../../utils/Common';
import { Deprecations } from '../../utils/Deprecations';
import { fetchAndProcessBlobFile, getAxiosWithTimeouts, isNetworkError } from '../../utils/HttpUtils';
import { transformPackageUrl } from '../../providers/cdn/PackageUrlTransformer';
import { fetchMergedPackageCatalog } from '../../r2mm/manager/FetchMergedPackageCatalog';
import { usesHexiumCatalog } from '../../utils/RepositoryUrls';
import {
    assertCurrentCatalogRefresh, captureCatalogRefresh, invalidateCatalogRefresh, isCurrentCatalogRefresh,
} from '../../r2mm/manager/CatalogRefresh';
import type { CatalogRefresh } from '../../r2mm/manager/CatalogRefresh';

export interface CachedMod {
    tsMod: ThunderstoreMod | undefined;
    isLatest: boolean;
}

export interface State {
    catalogGeneration: number;
    activeGameCacheStatus: string|undefined;
    cache: Map<string, CachedMod>;
    deprecated: Map<string, boolean>;
    exclusions: Set<string>;
    isThunderstoreModListUpdateInProgress: boolean;
    mods: ThunderstoreMod[];
    modsLastUpdated?: Date | undefined;
    thunderstoreModListUpdateError: Error|undefined;
    thunderstoreModListUpdateStatus: string;
}

type ProgressCallback = (progress: number) => void;
type PackageListChunk = {full_name: string}[];
export type PackageListIndex = {
    content: string[],
    hash: string,
    isLatest: boolean,
    request: CatalogRefresh,
    includeHexium?: boolean
};

function isPackageListChunk(value: unknown): value is PackageListChunk {
    return Array.isArray(value) && (
        !value.length || typeof value[0].full_name === "string"
    );
}

const EXCLUSIONS = 'https://raw.githubusercontent.com/ebkr/r2modmanPlus/master/modExclusions.md';
const PARTIAL_UPDATE_ERROR = 'Failed to fully refresh the online mod list. Some mod versions might be unavailable.';

/**
 * For dealing with mods listed in communities, i.e. available through
 * the Thunderstore API. Mods received from the API are stored in
 * IndexedDB (via Dexie). For performance they're also stored in memory
 * by this Vuex store module.
 */
export const TsModsModule = {
    namespaced: true,

    state: (): State => ({
        catalogGeneration: 0,
        /*** Does the active game have a mod list stored in IndexedDB? */
        activeGameCacheStatus: undefined,
        cache: new Map<string, CachedMod>(),
        deprecated: new Map<string, boolean>(),
        /*** Packages available through API that should be ignored by the manager */
        exclusions: new Set<string>(),
        /*** Mod list is updated from the API automatically and by user action */
        isThunderstoreModListUpdateInProgress: false,
        /*** All mods available through API for the current active game */
        mods: [],
        /*** When was the mod list last refreshed from the API? */
        modsLastUpdated: undefined,
        /*** Error shown on UI after mod list refresh fails */
        thunderstoreModListUpdateError: undefined,
        /*** Status shown on UI during mod list refresh */
        thunderstoreModListUpdateStatus: ''
    }),

    getters: <GetterTree<State, RootState>>{
        /** Vue components mostly process mods in ManifestV2 format,
         *  but sometimes need access to ThunderstoreMod format and
         *  related data too. Since filtering the whole mods list every
         *  time this happens slows down the LocalModList, cache the
         *  data in a Map.
         */
        cachedMod: (state) => (mod: ManifestV2): CachedMod => {
            const cacheKey = `${mod.getName()}-${mod.getVersionNumber()}`;
            return state.cache.get(cacheKey) as CachedMod;
        },

        /*** Categories used by any mod listed in the community */
        categories(state) {
            const categories = Array.from(
                new Set(
                    state.mods.map((mod) => mod.getCategories()).flat()
                )
            );
            categories.sort();
            return categories;
        },

        /*** Is the version of a mod defined by ManifestV2 the newest version? */
        isLatestVersion: (_state, getters) => (mod: ManifestV2): boolean => {
            return getters.cachedMod(mod)?.isLatest || false;
        },

        /*** Was the last successful mod list update more than an hour ago? */
        isModListOutdated(state) {
            return state.modsLastUpdated instanceof Date
                && (Date.now() - state.modsLastUpdated.getTime()) > (1000 * 60 * 60);
        },

        /*** A more concise version of the error message */
        conciseThunderstoreModListUpdateErrorMessage(state): string|undefined {
            if (!state.thunderstoreModListUpdateError) {
                return undefined;
            }

            let conciseError = "Failed to load mod list";
            if (isNetworkError(state.thunderstoreModListUpdateError)) {
                conciseError = "Failed to fully refresh the online mod list due to network error"
            } else if (state.thunderstoreModListUpdateError.name === PARTIAL_UPDATE_ERROR) {
                conciseError = "Failed to fully refresh the online mod list";
            }
            return conciseError;
        },

        /*** Return ThunderstoreMod representation of a ManifestV2 */
        tsMod: (_state, getters) => (mod: ManifestV2): ThunderstoreMod | undefined => {
            return getters.cachedMod(mod)?.tsMod;
        },

        undeprecatedModCount(state) {
            return [...state.deprecated].filter(([_, isDeprecated]) => !isDeprecated).length;
        }
    },

    mutations: <MutationTree<State>>{
        reset(state: State) {
            invalidateCatalogRefresh(state);
            state.cache = new Map<string, CachedMod>();
            state.deprecated = new Map<string, boolean>();
            state.mods = [];
            state.modsLastUpdated = undefined;
            state.thunderstoreModListUpdateError = undefined;
            state.thunderstoreModListUpdateStatus = '';
        },
        clearModCache(state) {
            state.cache.clear();
        },
        finishThunderstoreModListUpdate(state, request: CatalogRefresh) {
            if (state.catalogGeneration !== request.generation) return;
            state.activeGameCacheStatus = undefined;
            state.isThunderstoreModListUpdateInProgress = false;
            state.thunderstoreModListUpdateStatus = '';
        },
        setActiveGameCacheStatus(state, status: string|undefined) {
            state.activeGameCacheStatus = status;
        },
        setMods(state, payload: ThunderstoreMod[]) {
            // The mod list is large and immutable, replaced wholesale.
            // markRaw keeps Vue from deep-proxying every entry, which absolutely dominates
            // the load memory and time complexity.
            state.mods = markRaw(payload);
        },
        setModsLastUpdated(state, payload: Date|undefined) {
            state.modsLastUpdated = payload;
        },
        setExclusions(state, payload: string|string[]) {
            const exclusions_ = Array.isArray(payload) ? payload : payload.split('\n');
            state.exclusions = new Set(exclusions_.map((e) => e.trim()).filter(Boolean));
        },
        setThunderstoreModListUpdateError(state, error: Error) {
            state.thunderstoreModListUpdateError = error instanceof Error ? error : new Error(error);
        },
        setThunderstoreModListUpdateStatus(state, status: string) {
            state.thunderstoreModListUpdateStatus = status;
        },
        startThunderstoreModListUpdate(state) {
            invalidateCatalogRefresh(state);
            state.isThunderstoreModListUpdateInProgress = true;
        },
        updateDeprecated(state, allMods: ThunderstoreMod[]) {
            state.deprecated = Deprecations.getDeprecatedPackageMap(allMods);
        },
        prewarmCacheMod(state: State, mods: ThunderstoreMod[]) {
            const localState = new Map<string, CachedMod>(state.cache.entries());
            const modsByFullName = new Map(state.mods.map((m) => [m.getFullName(), m]));
            mods.forEach(mod => {
                const cacheKey = `${mod.getName()}-${mod.getVersionNumber()}`;

                if (localState.get(cacheKey) === undefined) {
                    const tsMod = modsByFullName.get(mod.getName());
                    if (tsMod === undefined) {
                        localState.set(cacheKey, {tsMod: undefined, isLatest: true});
                    } else {
                        const latestVersionNumber = new VersionNumber(tsMod.getLatestVersion());
                        const isLatest = mod.getVersionNumber().isEqualOrNewerThan(latestVersionNumber);
                        localState.set(cacheKey, {tsMod, isLatest});
                    }
                }
            });
            state.cache = localState;
        }
    },

    actions: <ActionTree<State, RootState>>{
        /**
         * Full update process of the mod list, to be used after
         * passing the splash screen.
         */
        async syncPackageList({commit, dispatch, state, rootGetters, rootState}): Promise<void> {
            if (state.isThunderstoreModListUpdateInProgress || rootGetters['download/activeDownloadCount'] > 0) {
                return;
            }

            commit('startThunderstoreModListUpdate');
            const request = captureCatalogRefresh(rootState);
            const check = () => assertCurrentCatalogRefresh(rootState, request);
            const sources = usesHexiumCatalog(request.community) ? 'Thunderstore and Hexium' : 'Thunderstore';

            try {
                commit('setThunderstoreModListUpdateStatus', `Checking for mod list updates from ${sources}...`);
                const packageListIndex: PackageListIndex = await dispatch('fetchPackageListIndex', request);
                check();

                if (packageListIndex.isLatest) {
                    await dispatch('cacheIndexHash', {request, hash: packageListIndex.hash});
                } else {
                    await dispatch('fetchAndCachePackageListChunks', {
                        packageListIndex,
                        progressCallback: (progress: number) => {
                            if (isCurrentCatalogRefresh(rootState, request)) {
                                commit('setThunderstoreModListUpdateStatus', `Loading latest mod list from ${sources}: ${progress}%`);
                            }
                        },
                    });
                }
                check();

                // An unchanged index still requires loading the list if Vuex is empty.
                if (packageListIndex.isLatest && state.mods.length > 0) {
                    await dispatch('updateModsLastUpdated', request);
                } else {
                    commit('setThunderstoreModListUpdateStatus', 'Processing the mod list...');
                    await dispatch('updateMods', request);
                    check();
                    commit('setThunderstoreModListUpdateStatus', 'Almost done...');
                    // Keep the profile read under the same generation guard as the catalog.
                    const profile = rootState.profile.activeProfile;
                    if (profile !== null) {
                        const mods = await ProfileModList.getModList(profile.asImmutableProfile());
                        check();
                        if (rootState.profile.activeProfile === profile && !(mods instanceof R2Error)) {
                            await dispatch('profile/updateModList', mods, {root: true});
                        }
                    }
                }
            } catch (e) {
                if (isCurrentCatalogRefresh(rootState, request)) commit('setThunderstoreModListUpdateError', e);
            } finally {
                // Finishing an obsolete request must not unlock a newer refresh or reset.
                commit('finishThunderstoreModListUpdate', request);
            }
        },

        async fetchPackageListIndex({rootState}, request: CatalogRefresh = captureCatalogRefresh(rootState)): Promise<PackageListIndex> {
            const check = () => assertCurrentCatalogRefresh(rootState, request);
            check();
            const {community} = request;
            const packageIndexUrl = transformPackageUrl(request.thunderstoreUrl);
            const indexUrl = CdnProvider.addCdnQueryParameter(packageIndexUrl);
            const options = {attempts: 5, interval: 2000, throwLastErrorAsIs: true};
            const index = await retry(() => fetchAndProcessBlobFile(indexUrl, {computeHash: true}), options);
            check();

            if (!isStringArray(index.content)) {
                throw new Error('Received invalid chunk index from API');
            }
            if (isEmptyArray(index.content)) {
                throw new Error('Received empty chunk index from API');
            }
            if (typeof index.hash !== 'string') {
                throw new Error('Failed to compute hash for the chunk index');
            }

            // An unchanged TS index must not suppress a Hexium-only update.
            if (usesHexiumCatalog(community)) {
                return {content: index.content, hash: `hexium-v1:${index.hash}`, isLatest: false, request, includeHexium: true};
            }
            const isLatest = await PackageDb.isLatestPackageListIndex(community, index.hash);
            check();
            return {content: index.content, hash: index.hash, isLatest, request};
        },

        async fetchAndCachePackageListChunks(
            {commit, dispatch, rootState, state},
            {packageListIndex, progressCallback}: {packageListIndex: PackageListIndex, progressCallback?: ProgressCallback},
        ): Promise<boolean> {
            const {request} = packageListIndex;
            const {community} = request;
            const check = () => assertCurrentCatalogRefresh(rootState, request);
            const reportProgress = (progress: number) => {
                if (isCurrentCatalogRefresh(rootState, request)) progressCallback?.(progress);
            };
            check();

            if (packageListIndex.includeHexium) {
                if (!usesHexiumCatalog(community)) {
                    throw new Error('Missing Valheim community for the combined catalog');
                }
                const packages = await fetchMergedPackageCatalog(
                    packageListIndex.content, new Set(state.exclusions), reportProgress
                );
                check();
                await PackageDb.replacePackageList(community, packages, packageListIndex.hash, check);
                check();
                return true;
            }

            const chunkCount = packageListIndex.content.length;
            let completed = 0;
            let successes = 0;
            const fetchedFullNames = new Set<string>();

            for (const chunkUrl of packageListIndex.content) {
                check();
                try {
                    const fullNames: string[] = await dispatch('fetchAndCachePackageListChunk', {chunkUrl, request});
                    check();
                    fullNames.forEach((name) => fetchedFullNames.add(name));
                    successes++;
                } catch (e) {
                    check();
                    console.error('Processing package list chunk failed.', e);
                } finally {
                    completed++;
                    reportProgress(Math.floor((completed / chunkCount) * 100));
                }
            }
            check();

            // Never prune or accept an index hash after a partial refresh.
            if (successes === chunkCount) {
                await PackageDb.pruneRemovedMods(community, fetchedFullNames, check);
                check();
                await dispatch('cacheIndexHash', {request, hash: packageListIndex.hash});
            } else {
                commit('setThunderstoreModListUpdateError',
                    new R2Error(
                        PARTIAL_UPDATE_ERROR,
                        `Only ${successes} out of ${chunkCount} parts of the list were updated successfully`,
                    )
                );
            }

            return successes === chunkCount;
        },

        async fetchAndCachePackageListChunk(
            {rootState, state},
            {chunkUrl, request}: {chunkUrl: string; request: CatalogRefresh},
        ): Promise<string[]> {
            const check = () => assertCurrentCatalogRefresh(rootState, request);
            check();
            const url = CdnProvider.replaceCdnHost(chunkUrl);
            const options = {throwLastErrorAsIs: true};
            const {content: chunk} = await retry(() => fetchAndProcessBlobFile(url), options);
            check();

            if (!isPackageListChunk(chunk)) {
                throw new Error(`Received invalid chunk from URL "${url}"`);
            }

            const filtered = chunk.filter((pkg) => !state.exclusions.has(pkg.full_name));
            await PackageDb.upsertPackageListChunk(request.community, filtered, check);
            check();
            return filtered.map((pkg) => pkg.full_name);
        },

        async gameHasCachedModList({rootState}, request: CatalogRefresh = captureCatalogRefresh(rootState)): Promise<boolean> {
            assertCurrentCatalogRefresh(rootState, request);
            const updated = await PackageDb.getLastPackageListUpdateTime(request.community);
            assertCurrentCatalogRefresh(rootState, request);
            return updated !== undefined;
        },

        async generateTroubleshootingString({state}): Promise<string> {
            return `${state.mods.length} mods, updated ${state.modsLastUpdated || 'never'}`;
        },

        async getActiveGameCacheStatus({commit, state, rootState}): Promise<string> {
            if (state.isThunderstoreModListUpdateInProgress) {
                return "Online mod list is currently updating, please wait for the operation to complete";
            }

            // Only check the status once, as this is used in the settings
            // where the value is polled on one second intervals.
            if (state.activeGameCacheStatus === undefined) {
                const request = captureCatalogRefresh(rootState);
                const displayName = rootState.activeGame.displayName;
                let status = '';
                try {
                    status = (await PackageDb.hasEntries(request.community))
                        ? `${displayName} has a local copy of online mod list`
                        : `${displayName} has no local copy stored`;
                } catch (e) {
                    console.error(e);
                    status = 'Error occurred while checking mod list status';
                }

                if (isCurrentCatalogRefresh(rootState, request)) commit('setActiveGameCacheStatus', status);
            }

            return state.activeGameCacheStatus || 'Unknown status';
        },

        async resetActiveGameCache({commit, rootState, state}) {
            if (state.isThunderstoreModListUpdateInProgress) return;

            commit('startThunderstoreModListUpdate');
            const request = captureCatalogRefresh(rootState);
            const check = () => assertCurrentCatalogRefresh(rootState, request);

            try {
                commit('setThunderstoreModListUpdateStatus', 'Resetting mod list cache...');
                await PackageDb.resetCommunity(request.community, check);
                check();
                commit('setModsLastUpdated', undefined);
            } catch (e) {
                if (isCurrentCatalogRefresh(rootState, request)) throw e;
            } finally {
                commit('finishThunderstoreModListUpdate', request);
            }
        },

        async updateExclusions({commit}) {
            // Read exclusion list from a bundled file to have some values available ASAP.
            const exclusionList: {exclusions: string[]} = await import('../../../modExclusions.json');
            commit('setExclusions', exclusionList.exclusions);

            const timeout = 20000;
            const options = {attempts: 5, interval: 1000, throwLastErrorAsIs: true};

            // Check for exclusion list updates from online.
            try {
                const axios = getAxiosWithTimeouts(timeout, timeout);
                const response = await retry(() => axios.get(EXCLUSIONS), options);

                if (typeof response.data === 'string') {
                    commit('setExclusions', response.data);
                } else {
                    throw new Error(`Received invalid exclusion list response from API: ${response.data}`);
                }
            } catch (e) {
                console.error(e);
            }
        },

        async updateMods({commit, dispatch, rootState}, request: CatalogRefresh = captureCatalogRefresh(rootState)) {
            const check = () => assertCurrentCatalogRefresh(rootState, request);
            check();
            const modList = await PackageDb.getPackagesAsThunderstoreMods(request.community, check);
            check();
            commit('setMods', modList);
            commit('updateDeprecated', modList);
            commit('clearModCache');
            await dispatch('updateModsLastUpdated', request);
        },

        async updateModsLastUpdated({commit, rootState}, request: CatalogRefresh = captureCatalogRefresh(rootState)) {
            assertCurrentCatalogRefresh(rootState, request);
            const updated = await PackageDb.getLastPackageListUpdateTime(request.community);
            assertCurrentCatalogRefresh(rootState, request);
            commit('setModsLastUpdated', updated);
        },

        async cacheIndexHash({rootState}, {request, hash}: {request: CatalogRefresh; hash: string}) {
            const check = () => assertCurrentCatalogRefresh(rootState, request);
            check();
            await PackageDb.setLatestPackageListIndex(request.community, hash, check);
        },
    }
}
