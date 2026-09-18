/**
 * Donation URLs are publisher-controlled and eventually reach shell.openExternal.
 * Accept only absolute HTTPS URLs without credentials. Return null for unusable
 * optional metadata instead of rejecting the package or invoking an OS protocol.
 */
export function normalizeDonationUrl(value: unknown): string | null {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f\\]/.test(value)) {
        return null;
    }

    const text = value.trim();
    // Require an explicit scheme and authority rather than letting URL repair
    // relative addresses, missing slashes or protocol-relative links.
    if (!/^https:\/\/[^/\s]/i.test(text)) {
        return null;
    }

    try {
        const url = new URL(text);
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
            return null;
        }
        // Pass the parsed representation downstream, never the untrusted input.
        return url.href;
    } catch {
        return null;
    }
}
