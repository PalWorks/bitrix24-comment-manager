import { describe, it, expect } from 'vitest';
import { parseLeadUrl } from '../../../extension/content/urlParser';

describe('parseLeadUrl', () => {
    describe('valid lead URLs', () => {
        it('should extract lead ID from a standard lead details URL', () => {
            const url = 'https://myportal.bitrix24.com/crm/lead/details/123/';
            expect(parseLeadUrl(url)).toBe('123');
        });

        it('should extract lead ID without trailing slash', () => {
            const url = 'https://myportal.bitrix24.com/crm/lead/details/456';
            expect(parseLeadUrl(url)).toBe('456');
        });

        it('should extract lead ID with query parameters', () => {
            const url = 'https://myportal.bitrix24.com/crm/lead/details/789/?tab=activity';
            expect(parseLeadUrl(url)).toBe('789');
        });

        it('should extract lead ID with hash fragment', () => {
            const url = 'https://myportal.bitrix24.com/crm/lead/details/101/#comments';
            expect(parseLeadUrl(url)).toBe('101');
        });

        it('should extract lead ID with both query and hash', () => {
            const url = 'https://myportal.bitrix24.com/crm/lead/details/202/?tab=main#section';
            expect(parseLeadUrl(url)).toBe('202');
        });

        it('should handle large lead IDs', () => {
            const url = 'https://myportal.bitrix24.com/crm/lead/details/9999999/';
            expect(parseLeadUrl(url)).toBe('9999999');
        });

        it('should handle subdomain variations', () => {
            const url = 'https://company-name.bitrix24.com/crm/lead/details/555/';
            expect(parseLeadUrl(url)).toBe('555');
        });

        it('should handle single-digit lead IDs', () => {
            const url = 'https://portal.bitrix24.com/crm/lead/details/1/';
            expect(parseLeadUrl(url)).toBe('1');
        });
    });

    describe('invalid URLs', () => {
        it('should return null for a CRM deal page', () => {
            const url = 'https://myportal.bitrix24.com/crm/deal/details/123/';
            expect(parseLeadUrl(url)).toBeNull();
        });

        it('should return null for a CRM contact page', () => {
            const url = 'https://myportal.bitrix24.com/crm/contact/details/123/';
            expect(parseLeadUrl(url)).toBeNull();
        });

        it('should return null for the CRM lead list page', () => {
            const url = 'https://myportal.bitrix24.com/crm/lead/list/';
            expect(parseLeadUrl(url)).toBeNull();
        });

        it('should match on any domain since content script is scoped by manifest', () => {
            const url = 'https://example.com/crm/lead/details/123/';
            expect(parseLeadUrl(url)).toBe('123');
        });

        it('should return null for the Bitrix24 home page', () => {
            const url = 'https://myportal.bitrix24.com/';
            expect(parseLeadUrl(url)).toBeNull();
        });

        it('should return null for a lead URL with non-numeric ID', () => {
            const url = 'https://myportal.bitrix24.com/crm/lead/details/abc/';
            expect(parseLeadUrl(url)).toBeNull();
        });

        it('should return null for a lead URL with missing ID', () => {
            const url = 'https://myportal.bitrix24.com/crm/lead/details/';
            expect(parseLeadUrl(url)).toBeNull();
        });

        it('should return null for http protocol', () => {
            const url = 'http://myportal.bitrix24.com/crm/lead/details/123/';
            expect(parseLeadUrl(url)).toBeNull();
        });
    });

    describe('edge cases', () => {
        it('should return null for an empty string', () => {
            expect(parseLeadUrl('')).toBeNull();
        });

        it('should return null for a null-like undefined string', () => {
            expect(parseLeadUrl(undefined as unknown as string)).toBeNull();
        });

        it('should return null for a malformed URL', () => {
            expect(parseLeadUrl('not-a-url')).toBeNull();
        });

        it('should return null for a partial path match', () => {
            const url = 'https://myportal.bitrix24.com/crm/lead/details';
            expect(parseLeadUrl(url)).toBeNull();
        });
    });
});
