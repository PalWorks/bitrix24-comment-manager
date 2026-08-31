/**
 * k6 Load Test: Bitrix24 Comment Operations
 *
 * Target: 200 concurrent virtual users (VUs)
 * Duration: 5 minutes sustained load
 *
 * Prerequisites:
 *   1. Install k6: https://k6.io/docs/getting-started/installation/
 *   2. Deploy backend to staging with valid Bitrix24 credentials
 *   3. Set environment variables:
 *      K6_BACKEND_URL (e.g., https://staging.example.com)
 *      K6_JWT_TOKEN (a valid JWT for the test agent)
 *      K6_LEAD_ID (a valid lead ID in the staging portal)
 *
 * Usage:
 *   k6 run tests/load/load-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const backendUrl = __ENV.K6_BACKEND_URL || 'http://localhost:3000';
const jwtToken = __ENV.K6_JWT_TOKEN || '';
const leadId = __ENV.K6_LEAD_ID || '12345';

const commentLatency = new Trend('comment_create_latency');
const errorRate = new Rate('error_rate');

export const options = {
    scenarios: {
        comment_creation: {
            executor: 'constant-vus',
            vus: 200,
            duration: '5m',
            exec: 'commentCreation',
        },
        mixed_operations: {
            executor: 'constant-vus',
            vus: 200,
            duration: '5m',
            exec: 'mixedOperations',
            startTime: '5m',
        },
    },
    thresholds: {
        comment_create_latency: ['p(95)<2000'],
        error_rate: ['rate<0.01'],
    },
};

function authHeaders() {
    return {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
    };
}

export function commentCreation() {
    const payload = JSON.stringify({
        lead_id: leadId,
        comment_body: `Load test comment from VU ${__VU} at ${Date.now()}`,
    });

    const response = http.post(
        `${backendUrl}/api/comments`,
        payload,
        { headers: authHeaders() },
    );

    commentLatency.add(response.timings.duration);
    const passed = check(response, {
        'status is 201': (r) => r.status === 201,
    });
    errorRate.add(!passed);

    sleep(1);
}

export function mixedOperations() {
    const roll = Math.random();

    if (roll < 0.70) {
        /** 70%: Create */
        const payload = JSON.stringify({
            lead_id: leadId,
            comment_body: `Mixed test create VU ${__VU} at ${Date.now()}`,
        });
        const res = http.post(`${backendUrl}/api/comments`, payload, {
            headers: authHeaders(),
        });
        errorRate.add(res.status !== 201);
    } else if (roll < 0.90) {
        /** 20%: Read (activity) */
        const res = http.get(`${backendUrl}/api/activity`, {
            headers: authHeaders(),
        });
        errorRate.add(res.status !== 200);
    } else if (roll < 0.95) {
        /** 5%: Edit (uses placeholder comment ID) */
        const payload = JSON.stringify({
            comment_body: `Mixed test update VU ${__VU} at ${Date.now()}`,
        });
        const res = http.put(`${backendUrl}/api/comments/1`, payload, {
            headers: authHeaders(),
        });
        errorRate.add(res.status !== 200 && res.status !== 404);
    } else {
        /** 5%: Delete (uses placeholder comment ID) */
        const res = http.del(`${backendUrl}/api/comments/1`, null, {
            headers: authHeaders(),
        });
        errorRate.add(res.status !== 200 && res.status !== 404);
    }

    sleep(1);
}
