export function listing(source: 'ts' | 'hex', numbers: string[], name = 'Mod', owner = 'Team') {
    const host = source === 'hex' ? 'valheim.hexium.gg' : 'thunderstore.io';
    return {
        owner, name, full_name: `${owner}-${name}`, package_url: `https://${host}/packages/${owner}/${name}`,
        categories: ['Tools'], is_deprecated: false, has_nsfw_content: false,
        versions: numbers.map(version_number => ({
            version_number, download_url: `https://${host}/${owner}/${name}/${version_number}.zip`,
            dependencies: [`${owner}-Dependency-${version_number}`], file_size: 100,
            description: `${source} ${version_number}`, icon: `https://${host}/icon.png`,
            is_active: true, downloads: 10, date_created: '2026-09-17T12:00:00Z',
        })),
    };
}

