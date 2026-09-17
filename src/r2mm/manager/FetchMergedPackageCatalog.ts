import CdnProvider from '../../providers/generic/connection/CdnProvider';
import {retry} from '../../utils/Common';
import {fetchAndProcessBlobFile, makeLongRunningGetRequest} from '../../utils/HttpUtils';
import {HEXIUM_ORIGIN} from '../../utils/RepositoryUrls';
import {CatalogPackage, mergePackageCatalogs} from './MergedPackageCatalog';

/** Fetch both sources completely before allowing the caller to replace the catalog. */
export async function fetchMergedPackageCatalog(
    thunderstoreChunks: string[],
    exclusions: ReadonlySet<string>,
    onProgress: (percent: number) => void = () => {},
): Promise<CatalogPackage[]> {
    const thunderstore: unknown[] = [];
    const total = thunderstoreChunks.length + 1;
    let completed = 0;
    const options = {throwLastErrorAsIs: true};
    for (const chunkUrl of thunderstoreChunks) {
        const url = CdnProvider.replaceCdnHost(chunkUrl);
        const {content} = await retry(() => fetchAndProcessBlobFile(url), options);
        if (!Array.isArray(content)) throw new Error(`Invalid Thunderstore catalog chunk: ${url}`);
        // Avoid spreading an arbitrarily large array into function arguments.
        for (const listing of content) thunderstore.push(listing);
        onProgress(Math.floor(++completed / total * 100));
    }

    // Use the full V1 listing, not the latest-only experimental package index.
    // It is intentionally fetched on every refresh, even when TS has not changed.
    const response = await retry(() => makeLongRunningGetRequest(`${HEXIUM_ORIGIN}/api/v1/package/`, {
        axiosConfig: {responseType: 'json'},
    }), options);
    const hexium: unknown = typeof response.data === 'string'
        ? JSON.parse(response.data.replace(/^\uFEFF/, ''))
        : response.data;
    const merged = mergePackageCatalogs(thunderstore, hexium, exclusions);
    if (merged.length === 0) throw new Error('Received an empty combined Valheim catalog');
    onProgress(100);
    return merged;
}
