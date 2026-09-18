export const HEXIUM_ORIGIN = 'https://valheim.hexium.gg';

/** Only Valheim opts into the combined catalog. Other games keep their original path. */
export function usesHexiumCatalog(community: string): boolean {
    return community.toLowerCase() === 'valheim';
}

function hasDomain(url: string, domain: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:'
            && (parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`));
    } catch {
        return false;
    }
}

export function isHexiumUrl(url: string): boolean {
    return hasDomain(url, 'hexium.gg');
}

export function isThunderstoreUrl(url: string): boolean {
    return hasDomain(url, 'thunderstore.io') || hasDomain(url, 'thunderstore.dev');
}
