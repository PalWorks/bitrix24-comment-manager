import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Mock environment variables before importing modules that depend on config.
 */
process.env.JWT_SECRET = 'test-secret-key-for-unit-tests';
process.env.JWT_EXPIRY_SECONDS = '3600';
process.env.BITRIX24_CLIENT_ID = 'test-client-id';
process.env.BITRIX24_CLIENT_SECRET = 'test-client-secret';
process.env.BITRIX24_PORTAL_DOMAIN = 'test.bitrix24.com';

import {
    signJwt,
    storeBitrixTokens,
    resetAllState,
} from '../../../backend/src/services/tokenService';

/**
 * Mock the bitrix24Client getLead function.
 */
vi.mock('../../../backend/src/services/bitrix24Client', () => ({
    getLead: vi.fn(),
}));

import { getLead } from '../../../backend/src/services/bitrix24Client';
const mockGetLead = vi.mocked(getLead);

import express, { Request, Response, NextFunction } from 'express';
import type { Server } from 'http';
import { leadsRouter } from '../../../backend/src/routes/leads';
import { AppError } from '../../../backend/src/utils/errors';

describe('Leads Route (refactored)', () => {
    let testApp: express.Express;
    let testServer: Server;
    let testPort: number;
    let validJwt: string;

    beforeEach(async () => {
        resetAllState();
        mockGetLead.mockReset();

        const claims = {
            memberId: 'member-leads-001',
            domain: 'test.bitrix24.com',
            clientEndpoint: 'https://test.bitrix24.com/rest/',
        };

        storeBitrixTokens('member-leads-001', {
            accessToken: 'bitrix-access-token',
            refreshToken: 'bitrix-refresh-token',
            clientEndpoint: 'https://test.bitrix24.com/rest/',
            domain: 'test.bitrix24.com',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
        });

        const { token } = signJwt(claims);
        validJwt = token;

        testApp = express();
        testApp.use(express.json());
        testApp.use('/api/leads', leadsRouter);
        testApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
            if (err instanceof AppError) {
                res.status(err.statusCode).json(err.toResponse());
                return;
            }
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
        });

        testServer = await new Promise<Server>((resolve) => {
            const s = testApp.listen(0, () => resolve(s));
        });

        const testAddr = testServer.address();
        if (typeof testAddr === 'object' && testAddr !== null) {
            testPort = testAddr.port;
        }
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => testServer.close(() => resolve()));
    });

    function baseUrl(path: string): string {
        return `http://localhost:${testPort}${path}`;
    }

    it('should use getLead from bitrix24Client and return lead data', async () => {
        mockGetLead.mockResolvedValue({ title: 'Test Lead Title' });

        const response = await fetch(baseUrl('/api/leads/12345'), {
            headers: { Authorization: `Bearer ${validJwt}` },
        });
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.lead_id).toBe('12345');
        expect(data.lead_name).toBe('Test Lead Title');
        expect(data.exists).toBe(true);

        expect(mockGetLead).toHaveBeenCalledWith(
            'https://test.bitrix24.com/rest/',
            'bitrix-access-token',
            'member-leads-001',
            '12345',
        );
    });

    it('should return 400 for non-numeric lead ID', async () => {
        const response = await fetch(baseUrl('/api/leads/abc'), {
            headers: { Authorization: `Bearer ${validJwt}` },
        });

        expect(response.status).toBe(400);
    });

    it('should return 401 without authorization header', async () => {
        const response = await fetch(baseUrl('/api/leads/12345'));

        expect(response.status).toBe(401);
    });

    it('should propagate bitrix24Client errors correctly', async () => {
        const { BitrixApiError } = await import('../../../backend/src/utils/errors');
        mockGetLead.mockRejectedValue(new BitrixApiError('Failed to retrieve lead.'));

        const response = await fetch(baseUrl('/api/leads/99999'), {
            headers: { Authorization: `Bearer ${validJwt}` },
        });

        expect(response.status).toBe(502);
    });
});
