/** A snapshot of the operation that owns catalog reads, writes and UI updates. */
export interface CatalogRefresh {
    readonly generation: number;
    readonly community: string;
    readonly thunderstoreUrl: string;
}

export interface CatalogRefreshState {
    catalogGeneration: number;
    activeGameCacheStatus: string | undefined;
    isThunderstoreModListUpdateInProgress: boolean;
    thunderstoreModListUpdateError: Error | undefined;
    thunderstoreModListUpdateStatus: string;
}

interface CatalogRootState {
    tsMods: CatalogRefreshState;
    activeGame: {internalFolderName: string; thunderstoreUrl: string};
}

/** Call only inside a Vuex mutation. Never reset the generation to zero. */
export function invalidateCatalogRefresh(state: CatalogRefreshState): void {
    state.catalogGeneration++;
    state.activeGameCacheStatus = undefined;
    state.isThunderstoreModListUpdateInProgress = false;
    state.thunderstoreModListUpdateError = undefined;
    state.thunderstoreModListUpdateStatus = '';
}

export function captureCatalogRefresh(rootState: CatalogRootState): CatalogRefresh {
    return {
        generation: rootState.tsMods.catalogGeneration,
        community: rootState.activeGame.internalFolderName,
        thunderstoreUrl: rootState.activeGame.thunderstoreUrl,
    };
}

export function isCurrentCatalogRefresh(rootState: CatalogRootState, request: CatalogRefresh): boolean {
    return rootState.tsMods.catalogGeneration === request.generation
        && rootState.activeGame.internalFolderName === request.community;
}

export class CatalogRefreshCancelledError extends Error {
    constructor() {
        super('Catalog refresh was superseded by another operation or game selection');
        this.name = 'CatalogRefreshCancelledError';
    }
}

/** Also usable inside a Dexie transaction: throwing cancels all its writes. */
export function assertCurrentCatalogRefresh(rootState: CatalogRootState, request: CatalogRefresh): void {
    if (!isCurrentCatalogRefresh(rootState, request)) throw new CatalogRefreshCancelledError();
}
