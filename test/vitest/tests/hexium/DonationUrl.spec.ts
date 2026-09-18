import {describe, expect, it, vi} from 'vitest';
import {normalizeDonationUrl} from '../../../../src/utils/DonationUrl';
import {mergePackageCatalogs} from '../../../../src/r2mm/manager/MergedPackageCatalog';
import ThunderstoreMod from '../../../../src/model/ThunderstoreMod';
import {listing} from './fixtures';

vi.mock('../../../../src/providers/generic/connection/CdnProvider', () => ({
    default: {addCdnQueryParameter: (url: string) => url},
}));

const rejected: unknown[] = [
    undefined, null, false, 42, {}, [], '', '   ',
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)',
    'data:text/plain,hello', 'file:///tmp/donation.txt',
    'steam://validate/892970', 'ms-settings:display',
    'com.epicgames.launcher://apps/example?action=launch',
    'mailto:author@example.com', 'ftp://example.com/donate',
    'http://example.com/donate', '//example.com/donate', '/donate',
    'example.com/donate', 'https:example.com/donate',
    'https:/example.com/donate', 'https:///example.com/donate',
    'https://', 'https://[invalid', 'https://example.com:99999/donate',
    'https://user@example.com/donate', 'https://user:password@example.com/donate',
    'https://:password@example.com/donate',
    'https://example.com\\donate', '\\\\server\\share\\donation.txt',
    'https://example.com/\u0000donate', 'https://example.com/\u007fdonate',
    '\nhttps://example.com/donate', 'https:\t//example.com/donate',
    'https://exa\nmple.com/donate', 'java\rscript:alert(1)',
    {toString() { throw new Error('Untrusted objects must not be coerced'); }},
];

const accepted: [string, string][] = [
    ['https://ko-fi.com/author', 'https://ko-fi.com/author'],
    ['https://www.paypal.com/donate?hosted_button_id=ABC#donate',
        'https://www.paypal.com/donate?hosted_button_id=ABC#donate'],
    ['HTTPS://EXAMPLE.COM:443/donate', 'https://example.com/donate'],
    [' https://example.com/donate ', 'https://example.com/donate'],
    ['https://example.com', 'https://example.com/'],
    ['https://example.com/a%20b?amount=5&currency=EUR',
        'https://example.com/a%20b?amount=5&currency=EUR'],
];

function summary(donation_link: unknown) {
    return {
        ...listing('hex', ['1.0.0']), donation_link,
        latest_version_number: '1.0.0', latest_description: 'Cached mod',
        latest_icon: 'https://example.com/icon.png', total_downloads: 10,
    };
}

describe('donation URL policy', () => {
    it.each(rejected.map(value => [value]))('rejects unsafe or malformed input %j', value => {
        expect(normalizeDonationUrl(value)).toBeNull();
        // Both database read paths must protect older, unsanitized cache entries.
        expect(ThunderstoreMod.parseFromThunderstoreData({
            ...listing('hex', ['1.0.0']), donation_link: value,
        }).getDonationLink()).toBeNull();
        expect(ThunderstoreMod.parseFromSummary(summary(value)).getDonationLink()).toBeNull();
    });

    it.each(accepted)('keeps and normalizes HTTPS donation URL %s', (input, expected) => {
        expect(normalizeDonationUrl(input)).toBe(expected);
        expect(normalizeDonationUrl(expected)).toBe(expected);
        expect(ThunderstoreMod.parseFromSummary(summary(input)).getDonationLink()).toBe(expected);
        expect(ThunderstoreMod.parseFromThunderstoreData({
            ...listing('hex', ['1.0.0']), donation_link: input,
        }).getDonationLink()).toBe(expected);
    });

    it.each(['ts', 'hex'] as const)('drops an unsafe optional link from %s without dropping the mod', source => {
        const input = {...listing(source, ['1.0.0']), donation_link: 'ms-settings:display'};
        const result = mergePackageCatalogs(source === 'ts' ? [input] : [], source === 'hex' ? [input] : []);
        expect(result).toHaveLength(1);
        expect(result[0]!.donation_link).toBeNull();
        expect(result[0]!.versions[0]!.version_number).toBe('1.0.0');
        expect(input.donation_link).toBe('ms-settings:display');
    });

    it('does not borrow the losing listing donation link when the selected one is unsafe', () => {
        const ts = {...listing('ts', ['1.0.0']), donation_link: 'https://example.com/ts'};
        const hex = {...listing('hex', ['1.0.0']), donation_link: 'steam://validate/892970'};
        const [pkg] = mergePackageCatalogs([ts], [hex]);
        expect(pkg!.donation_link).toBeNull();
        expect(pkg!.versions[0]!.download_url).toContain('hexium.gg');
    });

    it('preserves the selected source and its valid HTTPS donation link', () => {
        const ts = {...listing('ts', ['1.0.0']), donation_link: 'https://example.com/ts'};
        const hex = {...listing('hex', ['2.0.0']), donation_link: 'HTTPS://EXAMPLE.COM/hex'};
        expect(mergePackageCatalogs([ts], [hex])[0]!.donation_link).toBe('https://example.com/hex');
        const newerTs = {...listing('ts', ['3.0.0']), donation_link: ts.donation_link};
        expect(mergePackageCatalogs([newerTs], [hex])[0]!.donation_link).toBe('https://example.com/ts');
    });

    it('replaces a previous valid model link with null when the new value is invalid', () => {
        const mod = new ThunderstoreMod();
        mod.setDonationLink('https://example.com/donate');
        expect(mod.getDonationLink()).toBe('https://example.com/donate');
        mod.setDonationLink('file:///tmp/donation.txt');
        expect(mod.getDonationLink()).toBeNull();
    });
});
