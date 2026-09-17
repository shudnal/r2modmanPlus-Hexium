/**
 * One logical catalog and one artifact cache. A release is identified by its
 * full package name and version, not by the repository or archive bytes.
 */
export type CatalogSource = 'thunderstore' | 'hexium';

type JsonObject = Record<string, unknown>;

export interface CatalogVersion extends JsonObject {
    name: string;
    full_name: string;
    version_number: string;
    dependencies: string[];
    description: string;
    icon: string;
    download_url: string;
    downloads: number;
    file_size: number;
    is_active: boolean;
    date_created: string;
}

export interface CatalogPackage extends JsonObject {
    name: string;
    owner: string;
    full_name: string;
    package_url: string;
    categories: string[];
    is_deprecated: boolean;
    has_nsfw_content: boolean;
    versions: CatalogVersion[];
}

function object(value: unknown, context: string): JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid ${context}: expected an object`);
    }
    return value as JsonObject;
}

function requiredString(value: unknown, context: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Invalid ${context}: expected a non-empty string`);
    }
    return value;
}

function stringArray(value: unknown, context: string): string[] {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`Invalid ${context}: expected an array of strings`);
    }
    return [...value];
}

function nonNegativeNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function versionParts(version: string): number[] {
    const parts = version.split('.').map(Number);
    if (!/^\d+\.\d+\.\d+$/.test(version) || !parts.every(Number.isSafeInteger)) {
        throw new Error(`Invalid catalog version "${version}": expected three non-negative integers`);
    }
    return parts;
}

/** Positive when a is newer. Never compare version strings lexicographically. */
export function compareCatalogVersions(a: string, b: string): number {
    const left = versionParts(a);
    const right = versionParts(b);
    for (let i = 0; i < 3; i++) {
        const difference = left[i]! - right[i]!;
        if (difference !== 0) return difference;
    }
    return 0;
}

function httpsUrl(value: unknown, context: string): string {
    const text = requiredString(value, context);
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error(`Invalid ${context}: expected an HTTPS URL without credentials`);
    }
    return text;
}

function normalizePackage(value: unknown, source: CatalogSource): CatalogPackage | undefined {
    const raw = object(value, `${source} package`);
    const name = requiredString(raw.name, 'package name');
    const owner = requiredString(raw.owner, 'package owner');
    const fullName = requiredString(raw.full_name, 'package full_name');
    // These identifiers also become cache directory names. Legacy owners may contain hyphens.
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !/^[A-Za-z0-9_-]+$/.test(owner)
        || fullName !== `${owner}-${name}`) {
        throw new Error(`Invalid package identity "${fullName}" from ${source}`);
    }
    if (!Array.isArray(raw.versions)) {
        throw new Error(`Invalid versions for ${fullName} from ${source}`);
    }

    const seen = new Set<string>();
    const versions: CatalogVersion[] = [];
    for (const value of raw.versions) {
        const version = object(value, `${fullName} version`);
        // Do not offer a withdrawn release just because it is first in an API response.
        if (version.is_active === false) continue;
        const number = requiredString(version.version_number, `${fullName} version_number`);
        versionParts(number);
        if (seen.has(number)) throw new Error(`Duplicate version ${fullName}-${number} from ${source}`);
        seen.add(number);
        versions.push({
            ...version,
            name,
            full_name: `${fullName}-${number}`,
            version_number: number,
            dependencies: stringArray(version.dependencies, `${fullName}-${number} dependencies`),
            description: typeof version.description === 'string' ? version.description : '',
            icon: typeof version.icon === 'string' ? version.icon : '',
            download_url: httpsUrl(version.download_url, `${fullName}-${number} download_url`),
            downloads: nonNegativeNumber(version.downloads),
            // Hexium's supplied OpenAPI does not require file_size. Zero means unknown.
            file_size: nonNegativeNumber(version.file_size),
            is_active: true,
            date_created: typeof version.date_created === 'string' ? version.date_created : '',
        });
    }
    if (versions.length === 0) return undefined;
    versions.sort((a, b) => compareCatalogVersions(b.version_number, a.version_number));

    return {
        ...raw,
        name,
        owner,
        full_name: fullName,
        package_url: httpsUrl(raw.package_url, `${fullName} package_url`),
        categories: raw.categories == null ? [] : stringArray(raw.categories, `${fullName} categories`),
        rating_score: nonNegativeNumber(raw.rating_score),
        is_pinned: raw.is_pinned === true,
        is_deprecated: raw.is_deprecated === true,
        has_nsfw_content: raw.has_nsfw_content === true,
        donation_link: typeof raw.donation_link === 'string' ? raw.donation_link : null,
        date_created: typeof raw.date_created === 'string' ? raw.date_created : versions[0]!.date_created,
        date_updated: typeof raw.date_updated === 'string' ? raw.date_updated : versions[0]!.date_created,
        versions,
    };
}

/**
 * Keep all available versions, preferring the complete Hexium release record
 * only for an identical version. Package metadata follows the newest release;
 * categories are combined and deprecation must agree across available listings.
 * Neither input is modified, and malformed data aborts the refresh before writes.
 */
export function mergePackageCatalogs(
    thunderstore: unknown,
    hexium: unknown,
    exclusions: ReadonlySet<string> = new Set(),
): CatalogPackage[] {
    type Release = {version: CatalogVersion; listing: CatalogPackage};
    type Entry = {listings: CatalogPackage[]; releases: Map<string, Release>};
    const packages = new Map<string, Entry>();

    const add = (input: unknown, source: CatalogSource) => {
        if (!Array.isArray(input)) throw new Error(`Invalid ${source} catalog: expected an array`);
        const seen = new Set<string>();
        for (const item of input) {
            const raw = object(item, `${source} package`);
            if (typeof raw.full_name === 'string' && exclusions.has(raw.full_name)) continue;
            const listing = normalizePackage(raw, source);
            if (!listing) continue;
            if (seen.has(listing.full_name)) {
                throw new Error(`Duplicate package ${listing.full_name} from ${source}`);
            }
            seen.add(listing.full_name);
            let entry = packages.get(listing.full_name);
            if (!entry) {
                entry = {listings: [], releases: new Map()};
                packages.set(listing.full_name, entry);
            }
            entry.listings.push(listing);
            for (const version of listing.versions) {
                entry.releases.set(version.version_number, {version, listing});
            }
        }
    };

    add(thunderstore, 'thunderstore');
    add(hexium, 'hexium');

    return [...packages.values()].map(entry => {
        const releases = [...entry.releases.values()].sort(
            (a, b) => compareCatalogVersions(b.version.version_number, a.version.version_number)
        );
        return {
            ...releases[0]!.listing,
            categories: [...new Set(entry.listings.flatMap(listing => listing.categories))],
            is_deprecated: entry.listings.every(listing => listing.is_deprecated),
            has_nsfw_content: entry.listings.some(listing => listing.has_nsfw_content),
            versions: releases.map(release => release.version),
        };
    });
}
