import { RedisCacheService } from '../src/services/redis-cache.js';
import { normalizeSessionIdFromUserId } from '../src/utils/common.js';

describe('RedisCacheService', () => {
    test('computeBreakpoints ignores content after last cache_control', () => {
        const svc = new RedisCacheService({ REDIS_ENABLED: false });

        const reqA = {
            tools: [],
            system: null,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } },
                    { type: 'text', text: 'tail-A' }
                ]
            }]
        };

        const reqB = {
            tools: [],
            system: null,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } },
                    { type: 'text', text: 'tail-B-different' }
                ]
            }]
        };

        const bpA = svc.computeBreakpoints(reqA.tools, reqA.system, reqA.messages);
        const bpB = svc.computeBreakpoints(reqB.tools, reqB.system, reqB.messages);

        expect(bpA.length).toBe(1);
        expect(bpB.length).toBe(1);
        expect(bpA[0].hash).toBe(bpB[0].hash);
        expect(bpA[0].tokens).toBe(bpB[0].tokens);
    });

    test('lookupOrCreate uses atomic set and avoids duplicate creation accounting', async () => {
        const svc = new RedisCacheService({ REDIS_ENABLED: true });

        const store = new Map();
        const expirations = new Map();
        svc.client = {
            status: 'ready',
            get: jest.fn(async (key) => store.has(key) ? String(store.get(key)) : null),
            set: jest.fn(async (key, value, exKeyword, ttl, nxKeyword) => {
                if (nxKeyword !== 'NX' || exKeyword !== 'EX') return null;
                if (store.has(key)) return null;
                store.set(key, Number(value));
                expirations.set(key, ttl);
                return 'OK';
            }),
            expire: jest.fn(async (key, ttl) => {
                expirations.set(key, ttl);
                return 1;
            })
        };

        const breakpoints = [
            { hash: 'h1', tokens: 100, ttl: 300 },
            { hash: 'h2', tokens: 150, ttl: 300 }
        ];

        const first = await svc.lookupOrCreate('s1', breakpoints, 200);
        expect(first.cache_creation_input_tokens).toBe(150);
        expect(first.cache_read_input_tokens).toBe(0);

        const second = await svc.lookupOrCreate('s1', breakpoints, 200);
        expect(second.cache_read_input_tokens).toBeGreaterThan(0);
        expect(second.cache_creation_input_tokens).toBe(0);
        expect(second.uncached_input_tokens).toBeGreaterThanOrEqual(0);
    });
});

describe('Session normalization', () => {
    test('normalizeSessionIdFromUserId extracts _session UUID when present', () => {
        const input = 'abc_session_123e4567-e89b-12d3-a456-426614174000';
        const sessionId = normalizeSessionIdFromUserId(input);
        expect(sessionId).toBe('123e4567-e89b-12d3-a456-426614174000');
    });

    test('normalizeSessionIdFromUserId hashes plain user_id when no uuid marker', () => {
        const input = 'plain-user-id';
        const sessionId = normalizeSessionIdFromUserId(input);
        expect(typeof sessionId).toBe('string');
        expect(sessionId).toHaveLength(64);
    });
});
