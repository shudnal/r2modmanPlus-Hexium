import {transformPackageUrl} from '../providers/cdn/PackageUrlTransformer';
import {HEXIUM_ORIGIN, isHexiumUrl} from './RepositoryUrls';

export interface PackageDocumentTarget {
    owner: string;
    name: string;
    version: string;
    packageUrl: string;
}

export type PackageDocumentKind = 'readme' | 'changelog';

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(url, {...init, credentials: 'omit'});
    if (!response.ok) throw new Error(`Package document request failed (${response.status})`);
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Invalid package document response');
    }
    return data as Record<string, unknown>;
}

/** Return server-rendered HTML, matching the existing MarkdownRender component. */
export async function fetchPackageDocument(target: PackageDocumentTarget, kind: PackageDocumentKind): Promise<string> {
    const owner = encodeURIComponent(target.owner);
    const name = encodeURIComponent(target.name);
    const version = encodeURIComponent(target.version);
    if (!isHexiumUrl(target.packageUrl)) {
        const data = await fetchJson(transformPackageUrl(
            `https://thunderstore.io/api/cyberstorm/package/${owner}/${name}/v/${version}/${kind}/`
        ));
        if (typeof data.html !== 'string') throw new Error(`Invalid ${kind} HTML response`);
        return data.html;
    }

    const data = await fetchJson(`${HEXIUM_ORIGIN}/api/experimental/package/${owner}/${name}/${version}/${kind}/`);
    if (data.markdown === null || data.markdown === '') return '';
    if (typeof data.markdown !== 'string') throw new Error(`Invalid ${kind} Markdown response`);
    const markdown = data.markdown.replace(/^\uFEFF/, '');
    if (markdown.trim().length === 0) return '';
    if (markdown.length > 100000) throw new Error('Package document exceeds the Hexium renderer limit');
    // Hexium returns Markdown; inserting it directly with v-html would not render it.
    const rendered = await fetchJson(`${HEXIUM_ORIGIN}/api/experimental/frontend/render-markdown/`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({markdown}),
    });
    if (typeof rendered.html !== 'string') throw new Error('Invalid rendered package document');
    return rendered.html;
}
