import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {fetchPackageDocument} from '../../../../src/utils/PackageMarkdown';

const target = {owner: 'Team', name: 'Mod', version: '1.0.0', packageUrl: 'https://valheim.hexium.gg/mods/Team/Mod'};
const response = (body: unknown) => ({ok: true, json: async () => body});
const request = vi.fn();

describe('package documents', () => {
    beforeEach(() => { request.mockReset(); vi.stubGlobal('fetch', request); });
    afterEach(() => vi.unstubAllGlobals());

    it('keeps the Thunderstore HTML path', async () => {
        request.mockResolvedValue(response({html: '<p>TS</p>'}));
        expect(await fetchPackageDocument({...target, packageUrl: 'https://thunderstore.io/c/valheim/p/Team/Mod/'}, 'readme')).toBe('<p>TS</p>');
        expect(request.mock.calls[0]![0]).toContain('/api/cyberstorm/package/Team/Mod/v/1.0.0/readme/');
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('renders BOM-prefixed Hexium Markdown instead of treating it as HTML', async () => {
        request.mockResolvedValueOnce(response({markdown: '\uFEFF# Title'})).mockResolvedValueOnce(response({html: '<h1>Title</h1>'}));
        expect(await fetchPackageDocument(target, 'changelog')).toBe('<h1>Title</h1>');
        expect(request.mock.calls[0]![0]).toContain('/api/experimental/package/Team/Mod/1.0.0/changelog/');
        expect(request.mock.calls[1]![1]).toMatchObject({method: 'POST', body: JSON.stringify({markdown: '# Title'}), credentials: 'omit'});
    });
    it('does not send empty Markdown to the renderer', async () => {
        request.mockResolvedValue(response({markdown: null}));
        expect(await fetchPackageDocument(target, 'readme')).toBe('');
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('surfaces HTTP and response errors', async () => {
        request.mockResolvedValue({ok: false, status: 404});
        await expect(fetchPackageDocument(target, 'readme')).rejects.toThrow('404');
        request.mockResolvedValue(response({unexpected: true}));
        await expect(fetchPackageDocument(target, 'readme')).rejects.toThrow('Markdown');
    });
});
