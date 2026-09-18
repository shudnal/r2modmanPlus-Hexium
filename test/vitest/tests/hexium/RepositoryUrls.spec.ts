import {describe, expect, it, vi} from 'vitest';
import {isHexiumUrl, isThunderstoreUrl, usesHexiumCatalog} from '../../../../src/utils/RepositoryUrls';

vi.mock('../../../../src/utils/HttpUtils', () => ({getAxiosWithTimeouts: () => ({})}));
vi.mock('../../../../src/providers/cdn/CdnHostList', () => ({
    getCdns: () => [{protocol: 'https', host: 'gcdn.thunderstore.io'}],
}));
import CdnProvider from '../../../../src/providers/generic/connection/CdnProvider';

describe('repository routing', () => {
    it('opts in only Valheim', () => {
        expect(usesHexiumCatalog('Valheim')).toBe(true);
        expect(usesHexiumCatalog('valheim')).toBe(true);
        expect(usesHexiumCatalog('RiskOfRain2')).toBe(false);
    });
    it('matches exact domains and their subdomains, not substrings', () => {
        expect(isHexiumUrl('https://cdn.hexium.gg/file.zip')).toBe(true);
        expect(isThunderstoreUrl('https://gcdn.thunderstore.io/file.gz')).toBe(true);
        expect(isHexiumUrl('https://hexium.gg.example.com/file.zip')).toBe(false);
        expect(isThunderstoreUrl('https://evilthunderstore.io/file.zip')).toBe(false);
        expect(isThunderstoreUrl('https://example.com/thunderstore.io')).toBe(false);
        expect(isHexiumUrl('invalid')).toBe(false);
    });
    it('leaves Hexium URLs and signed query strings untouched with a selected TS CDN', () => {
        CdnProvider.togglePreferredCdn();
        const url = 'https://cdn.hexium.gg/uploads/Team/Mod/1.0.0.zip?signature=abc';
        expect(CdnProvider.replaceCdnHost(url)).toBe(url);
        expect(CdnProvider.addCdnQueryParameter(url)).toBe(url);
        expect(CdnProvider.replaceCdnHost('https://thunderstore.io/chunk.gz')).toContain('gcdn.thunderstore.io');
        expect(CdnProvider.addCdnQueryParameter('https://thunderstore.io/package/download/Team/Mod/1.0.0/')).toContain('cdn=');
    });
});
