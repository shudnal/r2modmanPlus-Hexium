import RequestItem from '../../model/requests/RequestItem';
import { ActionTree } from 'vuex';
import { State as RootState } from "../../store";
import type { PackageListIndex } from './TsModsModule';
import { captureCatalogRefresh, isCurrentCatalogRefresh } from '../../r2mm/manager/CatalogRefresh';
import type { CatalogRefresh } from '../../r2mm/manager/CatalogRefresh';

export interface State {
    requests: RequestItem[];
    splashText: string;
}

export type UpdateRequestItemBody = {
    requestName: string,
    value: number,
}

export const SplashModule = {
    namespaced: true,

    state: (): State => ({
        requests: [],
        splashText: '',
    }),
    mutations: {
        resetRequestProgresses(state: State) {
            state.requests.forEach((request) => request.setProgress(0));
        },
        initialiseRequests(state: State) {
            state.requests = [
                new RequestItem('UpdateCheck', 0),
                new RequestItem('PackageListIndex', 0),
                new RequestItem('PackageListChunks', 0),
                new RequestItem('Vuex', 0)
            ];
        },
        setSplashText(state: State, splashText: string) {
            state.splashText = splashText;
        },
        updateRequestItem(state: State, body: UpdateRequestItemBody) {
            const item = state.requests.find((ri) => ri.getName() === body.requestName);

            if (item === undefined) {
                throw new Error(`Unknown RequestItem "${body.requestName}"`);
            }

            item.setProgress(body.value);
        }
    },
    actions: <ActionTree<State, RootState>>{
        setSplashText({ commit }, splashText: string) {
            commit('setSplashText', splashText);
        },
        /**
         * @deprecated in favour of updateRequestItem to prevent raw mutation of a Vuex item.
         * @param state
         * @param requestName
         */
        getRequestItem({state}, requestName: string): RequestItem {
            const item = state.requests.find((ri) => ri.getName() === requestName);

            if (item === undefined) {
                throw new Error(`Unknown RequestItem "${requestName}"`);
            }

            return item;
        },
        async getThunderstoreMods({commit, dispatch, rootState}): Promise<boolean> {
            commit('tsMods/startThunderstoreModListUpdate', null, {root: true});
            const request = captureCatalogRefresh(rootState);
            const isCurrent = () => isCurrentCatalogRefresh(rootState, request);
            let hasPriorCache = false;

            try {
                hasPriorCache = await dispatch('doesGameHaveLocalCache', request);
                if (!isCurrent()) return false;

                if (!hasPriorCache) {
                    const packageListIndex = await dispatch('fetchPackageListIndex', request);
                    if (!isCurrent()) return false;
                    await dispatch('fetchPackageListChunksIfUpdated', packageListIndex);
                    if (!isCurrent()) return false;
                }

                await dispatch('triggerStoreModListUpdate', request);
            } catch (e) {
                if (isCurrent()) {
                    commit('tsMods/setThunderstoreModListUpdateError', e, {root: true});
                }
            } finally {
                commit('tsMods/finishThunderstoreModListUpdate', request, {root: true});
            }

            if (!isCurrent()) return false;
            if (hasPriorCache) {
                // Show the cached list immediately, then refresh it without blocking startup.
                dispatch('tsMods/syncPackageList', null, {root: true});
            }
            return true;
        },
        async fetchPackageListIndex({commit, dispatch, rootState}, request: CatalogRefresh): Promise<PackageListIndex | undefined> {
            if (!isCurrentCatalogRefresh(rootState, request)) return undefined;
            commit('setSplashText', 'Checking for online mod list updates');

            try {
                return await dispatch('tsMods/fetchPackageListIndex', request, {root: true});
            } catch (e) {
                if (isCurrentCatalogRefresh(rootState, request)) {
                    commit('tsMods/setThunderstoreModListUpdateError', e, {root: true});
                    console.error('SplashModule failed to fetch mod list index from API.', e);
                }
                return undefined;
            } finally {
                if (isCurrentCatalogRefresh(rootState, request)) {
                    commit('updateRequestItem', {
                        requestName: 'PackageListIndex',
                        value: 100
                    } as UpdateRequestItemBody);
                }
            }
        },
        async doesGameHaveLocalCache({dispatch, commit, rootState}, request: CatalogRefresh): Promise<boolean> {
            if (!isCurrentCatalogRefresh(rootState, request)) return false;
            commit('setSplashText', 'Checking for mod list in local cache');
            let hasCache = false;

            try {
                hasCache = await dispatch('tsMods/gameHasCachedModList', request, {root: true});
            } catch (e) {
                if (isCurrentCatalogRefresh(rootState, request)) {
                    console.error('SplashModule failed to check mod list in local cache', e);
                }
            }

            if (!isCurrentCatalogRefresh(rootState, request)) return false;
            if (hasCache) {
                commit('updateRequestItem', {
                    requestName: 'PackageListIndex',
                    value: 100
                } as UpdateRequestItemBody);
                commit('updateRequestItem', {
                    requestName: 'PackageListChunks',
                    value: 100
                } as UpdateRequestItemBody);
            }

            return hasCache;
        },
        async fetchPackageListChunksIfUpdated({ commit, dispatch, rootState }, packageListIndex?: PackageListIndex): Promise<boolean> {
            // Skip loading chunks if loading the index failed or this startup was superseded.
            if (!packageListIndex || !isCurrentCatalogRefresh(rootState, packageListIndex.request)) return false;
            const {request} = packageListIndex;
            commit('setSplashText', 'Loading the latest online mod list');

            const progressCallback = (progress: number) => {
                if (isCurrentCatalogRefresh(rootState, request)) {
                    commit('updateRequestItem', {
                        requestName: 'PackageListChunks',
                        value: progress
                    } as UpdateRequestItemBody);
                }
            };

            try {
                return await dispatch(
                    'tsMods/fetchAndCachePackageListChunks',
                    {packageListIndex, progressCallback},
                    {root: true}
                );
            } catch (e) {
                if (isCurrentCatalogRefresh(rootState, request)) {
                    commit('tsMods/setThunderstoreModListUpdateError', e, {root: true});
                    console.error('SplashModule failed to fetch mod list from API.', e);
                }
                return false;
            } finally {
                progressCallback(100);
            }
        },
        async triggerStoreModListUpdate({ commit, dispatch, rootState }, request: CatalogRefresh): Promise<void> {
            if (!isCurrentCatalogRefresh(rootState, request)) return;
            commit('setSplashText', 'Processing the mod list');

            try {
                await dispatch('tsMods/updateMods', request, {root: true});
            } catch (e) {
                if (isCurrentCatalogRefresh(rootState, request)) {
                    console.error('Updating the store mod list by SplashModule failed.', e);
                }
            } finally {
                if (isCurrentCatalogRefresh(rootState, request)) {
                    commit('updateRequestItem', {
                        requestName: 'Vuex',
                        value: 100
                    } as UpdateRequestItemBody);
                }
            }
        }
    }
}
