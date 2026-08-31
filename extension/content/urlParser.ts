import { CONFIG } from '../shared/constants';

/**
 * Parses a URL to extract a Bitrix24 CRM lead ID.
 *
 * Matches any https URL whose path contains `/crm/lead/details/{id}`, which
 * covers portals on any Bitrix24 domain, on a customer owned domain, and self
 * hosted installations served under a path prefix. Trailing slashes, query
 * parameters, and hash fragments are all tolerated.
 *
 * @param url The full page URL to parse
 * @returns The numeric lead ID as a string, or null if the URL is not a lead page
 */
export function parseLeadUrl(url: string): string | null {
    if (!url) {
        return null;
    }

    let pathname: string;
    try {
        const parsed = new URL(url);
        // Content scripts are only ever registered for https origins, both in
        // the static manifest match and in optional_host_permissions, so an
        // http URL is not a page this extension can be running on.
        if (parsed.protocol !== 'https:') {
            return null;
        }
        pathname = parsed.pathname;
    } catch {
        return null;
    }

    const match = pathname.match(CONFIG.LEAD_PATH_PATTERN);

    if (!match || !match[1]) {
        return null;
    }

    return match[1];
}
