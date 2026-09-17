import {beforeEach, describe, expect, it, vi} from 'vitest';
import {listing} from './fixtures';

const network = vi.hoisted(() => ({chunk: vi.fn(), json: vi.fn()}));
vi.mock('../../../../src/utils/Common', () => ({retry: (fn: () => Promise<unknown>) => fn()}));
vi.mock('../../../../src/utils/HttpUtils', () => ({
    fetchAndProcessBlobFile: network.chunk,
    makeLongRunningGetRequest: network.json,
}));
vi.mock('../../../../src/providers/generic/connection/CdnProvider', () => ({
    default: {replaceCdnHost: (url: string) => url},
}));
import {fetchMergedPackageCatalog} from '../../../../src/r2mm/manager/FetchMergedPackageCatalog';

describe('combined catalog loading', () => {
    beforeEach(() => vi.resetAllMocks());

    it('requests Hexium on every refresh, even with the same TS chunk URLs', async () => {
        network.chunk.mockResolvedValue({content: [listing('ts', ['1.0.0'])]});
        network.json.mockResolvedValueOnce({data: [listing('hex', ['1.1.0'])]})
            .mockResolvedValueOnce({data: [listing('hex', ['1.2.0'])]});
        const first = await fetchMergedPackageCatalog(['https://thunderstore.io/chunk.gz'], new Set());
        const second = await fetchMergedPackageCatalog(['https://thunderstore.io/chunk.gz'], new Set());
        expect(first[0]!.versions[0]!.version_number).toBe('1.1.0');
        expect(second[0]!.versions[0]!.version_number).toBe('1.2.0');
        expect(network.json).toHaveBeenCalledTimes(2);
        expect(network.json.mock.calls[0]![0]).toBe('https://valheim.hexium.gg/api/v1/package/');
    });

    it('combines every TS chunk and accepts a BOM-prefixed JSON response', async () => {
        network.chunk.mockResolvedValueOnce({content: [listing('ts', ['1.0.0'], 'First')]})
            .mockResolvedValueOnce({content: [listing('ts', ['1.0.0'], 'Second')]});
        network.json.mockResolvedValue({data: '\uFEFF' + JSON.stringify([listing('hex', ['2.0.0'], 'Third')])});
        const progress = vi.fn();
        const result = await fetchMergedPackageCatalog(['https://thunderstore.io/1.gz', 'https://thunderstore.io/2.gz'], new Set(), progress);
        expect(result).toHaveLength(3);
        expect(progress).toHaveBeenLastCalledWith(100);
    });

    it('rejects a failed TS chunk rather than returning a partial catalog', async () => {
        network.chunk.mockRejectedValue(new Error('chunk unavailable'));
        await expect(fetchMergedPackageCatalog(['https://thunderstore.io/1.gz'], new Set())).rejects.toThrow('chunk unavailable');
        expect(network.json).not.toHaveBeenCalled();
    });

    it('rejects a failed Hexium fetch rather than returning only TS', async () => {
        network.chunk.mockResolvedValue({content: [listing('ts', ['1.0.0'])]});
        network.json.mockRejectedValue(new Error('Hexium unavailable'));
        await expect(fetchMergedPackageCatalog(['https://thunderstore.io/1.gz'], new Set())).rejects.toThrow('Hexium unavailable');
    });

    it('rejects a malformed or empty result before it can be saved', async () => {
        network.chunk.mockResolvedValue({content: []});
        network.json.mockResolvedValue({data: {error: 'invalid'}});
        await expect(fetchMergedPackageCatalog(['https://thunderstore.io/1.gz'], new Set())).rejects.toThrow('catalog');
        network.json.mockResolvedValue({data: []});
        await expect(fetchMergedPackageCatalog(['https://thunderstore.io/1.gz'], new Set())).rejects.toThrow('empty combined');
    });
});
