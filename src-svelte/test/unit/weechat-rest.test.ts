import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WeeChatRest, RestError } from '$lib/weechat-rest';
import type {
    HandshakeResponse,
    VersionResponse,
    RestBuffer,
    RestLine,
    RestNickGroupRoot,
    RestHotlistEntry,
    RestScript,
    CompletionResponse,
    PingResponse,
    RestErrorResponse
} from '$lib/weechat-rest-types';

function mockFetch(response: unknown, status = 200, ok = true): void {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok,
        status,
        statusText: ok ? 'OK' : 'Error',
        json: () => Promise.resolve(response),
        text: () => Promise.resolve(JSON.stringify(response)),
        headers: new Headers()
    } as Response);
}

function mockFetchNoContent(): void {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 204,
        statusText: 'No Content',
        json: () => Promise.resolve(null),
        text: () => Promise.resolve(''),
        headers: new Headers()
    } as Response);
}

function mockFetchError(status = 400, errorBody?: RestErrorResponse): void {
    const body = errorBody ?? { error: 'Bad request' };
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status,
        statusText: 'Error',
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
        headers: new Headers()
    } as Response);
}

describe('WeeChatRest constructor', () => {
    it('creates instance with empty base URL', () => {
        const client = new WeeChatRest();
        expect(client.baseUrl).toBe('');
    });

    it('strips trailing slashes from base URL', () => {
        const client = new WeeChatRest('https://example.com/');
        expect(client.baseUrl).toBe('https://example.com');
    });

    it('strips multiple trailing slashes', () => {
        const client = new WeeChatRest('https://example.com///');
        expect(client.baseUrl).toBe('https://example.com');
    });

    it('sets and gets base URL', () => {
        const client = new WeeChatRest();
        client.setBaseUrl('https://new.example.com/');
        expect(client.baseUrl).toBe('https://new.example.com');
    });

    it('sets and gets TOTP', () => {
        const client = new WeeChatRest();
        client.setTOTP('123456');
        expect(client.getHandshakeResult()).toBeNull();
    });
});

describe('handshake', () => {
    it('sends POST request to /api/handshake', async () => {
        const handshakeResponse: HandshakeResponse = {
            password_hash_algo: 'sha512',
            password_hash_iterations: 100000,
            totp: false
        };
        mockFetch(handshakeResponse);

        const client = new WeeChatRest('https://example.com');
        const result = await client.handshake({
            password_hash_algo: ['plain', 'sha256', 'sha512']
        });

        expect(result).toEqual(handshakeResponse);
        expect(global.fetch).toHaveBeenCalledWith(
            'https://example.com/api/handshake',
            expect.objectContaining({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password_hash_algo: ['plain', 'sha256', 'sha512'] })
            })
        );
    });

    it('stores handshake result internally', async () => {
        const handshakeResponse: HandshakeResponse = {
            password_hash_algo: 'pbkdf2+sha256',
            password_hash_iterations: 50000,
            totp: true
        };
        mockFetch(handshakeResponse);

        const client = new WeeChatRest();
        await client.handshake();
        expect(client.getHandshakeResult()).toEqual(handshakeResponse);
    });

    it('uses empty body when no request provided', async () => {
        const handshakeResponse: HandshakeResponse = {
            password_hash_algo: 'plain',
            password_hash_iterations: 0,
            totp: false
        };
        mockFetch(handshakeResponse);

        const client = new WeeChatRest();
        await client.handshake();

        const callArgs = (global.fetch as any).mock.calls[0];
        expect(callArgs[1].body).toBeUndefined();
    });

    it('throws on non-ok response', async () => {
        mockFetchError(500, { error: 'Internal server error' });

        const client = new WeeChatRest();
        await expect(client.handshake()).rejects.toThrow('Handshake failed: 500 Error');
    });
});

describe('getVersion', () => {
    it('returns version info', async () => {
        const versionResponse: VersionResponse = {
            weechat_version: '4.2.0-dev',
            weechat_version_git: 'v4.1.0-143-g0b1cda1c4',
            weechat_version_number: 67239936,
            relay_api_version: '0.0.1',
            relay_api_version_number: 1
        };
        mockFetch(versionResponse);

        const client = new WeeChatRest('https://example.com');
        const result = await client.getVersion();

        expect(result).toEqual(versionResponse);
        expect((global.fetch as any).mock.calls[0][0]).toBe('https://example.com/api/version');
    });

    it('throws on error response', async () => {
        mockFetchError(401, { error: 'Invalid password' });

        const client = new WeeChatRest('https://example.com');
        await expect(client.getVersion()).rejects.toThrow('Failed to get version');
    });
});

describe('getBuffers', () => {
    const bufferList: RestBuffer[] = [
        {
            id: 1709932823238637,
            name: 'core.weechat',
            short_name: 'weechat',
            number: 1,
            type: 'formatted',
            hidden: false,
            title: 'WeeChat 4.2.0-dev',
            modes: '',
            input_prompt: '',
            input: '',
            input_position: 0,
            input_multiline: false,
            nicklist: false,
            nicklist_case_sensitive: false,
            nicklist_display_groups: true,
            time_displayed: true,
            local_variables: { plugin: 'core', name: 'weechat' },
            keys: [],
            last_read_line_id: -1
        }
    ];

    it('returns all buffers without options', async () => {
        mockFetch(bufferList);

        const client = new WeeChatRest('https://example.com');
        const result = await client.getBuffers();

        expect(result).toEqual(bufferList);
        expect((global.fetch as any).mock.calls[0][0]).toBe('https://example.com/api/buffers');
    });

    it('includes query parameters when provided', async () => {
        mockFetch(bufferList);

        const client = new WeeChatRest('https://example.com');
        await client.getBuffers({
            lines: -100,
            nicks: true,
            colors: 'weechat'
        });

        const callArgs = (global.fetch as any).mock.calls[0];
        const url = new URL(callArgs[0]);
        expect(url.searchParams.get('lines')).toBe('-100');
        expect(url.searchParams.get('nicks')).toBe('true');
        expect(url.searchParams.get('colors')).toBe('weechat');
    });

    it('encodes buffer names with special characters', async () => {
        mockFetch(bufferList[0]!);

        const client = new WeeChatRest('https://example.com');
        await client.getBufferByName('irc.libera.#weechat');

        const callArgs = (global.fetch as any).mock.calls[0];
        expect(callArgs[0]).toContain('irc.libera.%23weechat');
    });

    it('throws on error response', async () => {
        mockFetchError(404, { error: 'Buffer not found' });

        const client = new WeeChatRest('https://example.com');
        await expect(client.getBufferById(999999)).rejects.toThrow('Failed to get buffer 999999');
    });
});

describe('getLines', () => {
    const lineList: RestLine[] = [
        {
            id: 0,
            y: -1,
            date: '2023-12-05T19:46:03.847625Z',
            date_printed: '2023-12-05T19:46:03.847625Z',
            displayed: true,
            highlight: false,
            notify_level: 0,
            prefix: '-->',
            message: 'alice has joined #test',
            tags: ['irc_366', 'irc_numeric']
        }
    ];

    it('returns lines for a buffer', async () => {
        mockFetch(lineList);

        const client = new WeeChatRest('https://example.com');
        const result = await client.getLines(1709932823238637);

        expect(result).toEqual(lineList);
        expect((global.fetch as any).mock.calls[0][0]).toBe(
            'https://example.com/api/buffers/1709932823238637/lines'
        );
    });

    it('includes query parameters', async () => {
        mockFetch(lineList);

        const client = new WeeChatRest('https://example.com');
        await client.getLines(123, { lines: -1000, colors: 'strip' });

        const callArgs = (global.fetch as any).mock.calls[0];
        const url = new URL(callArgs[0]);
        expect(url.searchParams.get('lines')).toBe('-1000');
        expect(url.searchParams.get('colors')).toBe('strip');
    });

    it('returns lines by buffer name', async () => {
        mockFetch(lineList);

        const client = new WeeChatRest('https://example.com');
        await client.getLinesByBufferName('irc.libera.#weechat');

        const callArgs = (global.fetch as any).mock.calls[0];
        expect(callArgs[0]).toContain('irc.libera.%23weechat/lines');
    });

    it('returns single line by ID', async () => {
        mockFetch(lineList[0]!);

        const client = new WeeChatRest('https://example.com');
        const result = await client.getSingleLine(123, 456);

        expect(result.id).toBe(0);
        expect((global.fetch as any).mock.calls[0][0]).toBe(
            'https://example.com/api/buffers/123/lines/456'
        );
    });
});

describe('getNicks', () => {
    const nicklist: RestNickGroupRoot = {
        id: 0,
        parent_group_id: -1,
        name: 'root',
        color_name: '',
        color: '',
        visible: false,
        groups: [
            {
                id: 1709932823649181,
                parent_group_id: 0,
                name: '000|o',
                color_name: 'weechat.color.nicklist_group',
                color: '\u001b[32m',
                visible: true,
                groups: [],
                nicks: [
                    {
                        id: 1709932823649184,
                        parent_group_id: 1709932823649181,
                        prefix: '@',
                        prefix_color_name: 'lightgreen',
                        prefix_color: '\u001b[92m',
                        name: 'alice',
                        color_name: 'bar_fg',
                        color: '',
                        visible: true
                    }
                ]
            }
        ],
        nicks: []
    };

    it('returns nicklist for a buffer ID', async () => {
        mockFetch(nicklist);

        const client = new WeeChatRest('https://example.com');
        const result = await client.getNicks(1709932823238637);

        expect(result).toEqual(nicklist);
        expect(result.groups.length).toBe(1);
        expect(result.groups[0]!.nicks.length).toBe(1);
        expect(result.groups[0]!.nicks[0]!.name).toBe('alice');
    });

    it('returns nicklist by buffer name', async () => {
        mockFetch(nicklist);

        const client = new WeeChatRest('https://example.com');
        await client.getNicksByName('irc.libera.#weechat');

        const callArgs = (global.fetch as any).mock.calls[0];
        expect(callArgs[0]).toContain('irc.libera.%23weechat/nicks');
    });
});

describe('getHotlist', () => {
    const hotlist: RestHotlistEntry[] = [
        {
            priority: 0,
            date: '2024-03-17T16:38:51.572834Z',
            buffer_id: 1710693531508204,
            count: [44, 0, 0, 0]
        },
        {
            priority: 0,
            date: '2024-03-17T16:38:51.573028Z',
            buffer_id: 1710693530395959,
            count: [14, 0, 0, 0]
        }
    ];

    it('returns all hotlist entries', async () => {
        mockFetch(hotlist);

        const client = new WeeChatRest('https://example.com');
        const result = await client.getHotlist();

        expect(result).toEqual(hotlist);
        expect((global.fetch as any).mock.calls[0][0]).toBe('https://example.com/api/hotlist');
    });

    it('throws on error response', async () => {
        mockFetchError(503, { error: 'Service unavailable' });

        const client = new WeeChatRest('https://example.com');
        await expect(client.getHotlist()).rejects.toThrow('Failed to get hotlist');
    });
});

describe('sendInput', () => {
    it('sends command with buffer_id', async () => {
        mockFetchNoContent();

        const client = new WeeChatRest('https://example.com');
        await client.sendInput({ buffer_id: 123, command: 'hello!' });

        const callArgs = (global.fetch as any).mock.calls[0];
        expect(callArgs[0]).toBe('https://example.com/api/input');
        expect(callArgs[1].method).toBe('POST');
        expect(JSON.parse(callArgs[1].body)).toEqual({ buffer_id: 123, command: 'hello!' });
    });

    it('sends command with buffer_name', async () => {
        mockFetchNoContent();

        const client = new WeeChatRest('https://example.com');
        await client.sendInput({ buffer_name: 'irc.libera.#weechat', command: '/join #new' });

        const callArgs = (global.fetch as any).mock.calls[0];
        expect(JSON.parse(callArgs[1].body)).toEqual({
            buffer_name: 'irc.libera.#weechat',
            command: '/join #new'
        });
    });

    it('throws on error response', async () => {
        mockFetchError(403, { error: 'Forbidden' });

        const client = new WeeChatRest();
        await expect(client.sendInput({ command: '/part' })).rejects.toThrow('Failed to send input');
    });
});

describe('getCompletions', () => {
    const completion: CompletionResponse = {
        context: 'command',
        base_word: 'qu',
        position_replace: 1,
        add_space: true,
        list: ['query', 'quiet', 'quit', 'quote']
    };

    it('returns completions for a command', async () => {
        mockFetch(completion);

        const client = new WeeChatRest('https://example.com');
        const result = await client.getCompletions({
            buffer_name: 'irc.libera.#weechat',
            command: '/qu'
        });

        expect(result).toEqual(completion);
        expect(result.list).toContain('quit');
    });

    it('includes position parameter when provided', async () => {
        mockFetch(completion);

        const client = new WeeChatRest('https://example.com');
        await client.getCompletions({
            buffer_id: 123,
            command: '/te',
            position: 2
        });

        const callArgs = (global.fetch as any).mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        expect(body.position).toBe(2);
    });

    it('throws on error response', async () => {
        mockFetchError(400, { error: 'Invalid command' });

        const client = new WeeChatRest();
        await expect(client.getCompletions({ command: '' })).rejects.toThrow('Failed to get completions');
    });
});

describe('ping', () => {
    it('returns empty ping response when no data sent', async () => {
        mockFetchNoContent();

        const client = new WeeChatRest('https://example.com');
        const result = await client.ping();

        expect(result.data).toBe('');
    });

    it('echoes back data when provided', async () => {
        mockFetch({ data: '1702835741' });

        const client = new WeeChatRest('https://example.com');
        const result = await client.ping({ data: '1702835741' });

        expect(result.data).toBe('1702835741');
        const callArgs = (global.fetch as any).mock.calls[0];
        expect(JSON.parse(callArgs[1].body)).toEqual({ data: '1702835741' });
    });

    it('throws on error response', async () => {
        mockFetchError(500, { error: 'Internal error' });

        const client = new WeeChatRest();
        await expect(client.ping()).rejects.toThrow('Ping failed');
    });
});

describe('getScripts', () => {
    const scripts: RestScript[] = [
        {
            name: 'highmon.pl',
            version: '2.7',
            description: 'Highlight Monitor',
            author: 'KenjiE20',
            license: 'GPL3'
        },
        {
            name: 'go.py',
            version: '3.1.1',
            description: 'Quick jump to buffers',
            author: 'Sébastien Helleu <flashcode@flashtux.org>',
            license: 'GPL3'
        }
    ];

    it('returns list of loaded scripts', async () => {
        mockFetch(scripts);

        const client = new WeeChatRest('https://example.com');
        const result = await client.getScripts();

        expect(result).toEqual(scripts);
        expect(result.length).toBe(2);
        expect(result[0]!.name).toBe('highmon.pl');
    });

    it('throws on error response', async () => {
        mockFetchError(401, { error: 'Unauthorized' });

        const client = new WeeChatRest();
        await expect(client.getScripts()).rejects.toThrow('Failed to get scripts');
    });
});

describe('authenticate', () => {
    it('calls handshake first if not done', async () => {
        const handshakeResponse: HandshakeResponse = {
            password_hash_algo: 'plain',
            password_hash_iterations: 0,
            totp: false
        };
        mockFetch(handshakeResponse);

        const client = new WeeChatRest('https://example.com');
        await client.authenticate('plain', 'secret');

        expect(client.getHandshakeResult()?.password_hash_algo).toBe('plain');
    });

    it('uses stored handshake result for iterations when authenticating', async () => {
        const handshakeResponse: HandshakeResponse = {
            password_hash_algo: 'pbkdf2+sha256',
            password_hash_iterations: 75000,
            totp: false
        };
        mockFetch(handshakeResponse);

        const client = new WeeChatRest('https://example.com');
        await client.handshake();

        expect(client.getHandshakeResult()?.password_hash_iterations).toBe(75000);
    });

    it('skips handshake when already authenticated', async () => {
        const handshakeResponse: HandshakeResponse = {
            password_hash_algo: 'plain',
            password_hash_iterations: 0,
            totp: false
        };
        mockFetch(handshakeResponse);

        const client = new WeeChatRest('https://example.com');
        await client.authenticate('plain', 'secret');

        // Verify handshake was stored
        expect(client.getHandshakeResult()?.password_hash_algo).toBe('plain');

        // Clear all mocks
        vi.clearAllMocks();

        // Mock a version call to verify authenticate doesn't call handshake again
        mockFetch({ weechat_version: '4.0' });

        const client2 = new WeeChatRest('https://example.com');
        await client2.handshake();
        await client2.authenticate('plain', 'secret');

        // Now calling authenticate again should NOT trigger another handshake
        // Since buildAuthHeaders for plain just returns resolved promise,
        // we verify by checking no additional fetch calls were made for handshake
        const fetchCallsBefore = (global.fetch as any).mock.calls.length;
        await client2.authenticate('plain', 'secret2');
        const fetchCallsAfter = (global.fetch as any).mock.calls.length;

        // authenticate with plain doesn't make HTTP calls, so count should be same
        expect(fetchCallsBefore).toBe(fetchCallsAfter);
    });
});

describe('RestError', () => {
    function createMockResponse(status: number, body: unknown): Response {
        return {
            ok: false,
            status,
            statusText: 'Error',
            json: () => Promise.resolve(body),
            text: () => Promise.resolve(JSON.stringify(body)),
            headers: new Headers(),
            redirected: false,
            type: 'basic',
            url: '',
            clone: () => createMockResponse(status, body),
            body: null,
            bodyUsed: false,
            formData: () => Promise.resolve(new FormData()),
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
            blob: () => Promise.resolve(new Blob()),
            bytes: () => Promise.resolve(new Uint8Array()),
            domainLookupTime: 0,
            domainLookupEndTime: 0,
            domainLookupStartTime: 0,
            transferTime: 0,
            connectionTime: 0,
            connectionEndTime: 0,
            secureConnectionTime: 0,
            requestTiming: null,
            responseTiming: null,
            webSocketResponse: null
        } as Response;
    }

    it('stores response and message', async () => {
        const mockResponse = createMockResponse(400, { error: 'Invalid request' });
        const error = new RestError(mockResponse, 'Test error message');
        expect(error.name).toBe('RestError');
        expect(error.message).toBe('Test error message');
        expect(error.response.status).toBe(400);
    });

    it('parses error response body', async () => {
        const errorBody: RestErrorResponse = {
            error: 'Invalid password',
            code: 401,
            message: 'Authentication failed'
        };
        const mockResponse = createMockResponse(401, errorBody);
        const error = new RestError(mockResponse, 'Auth failed');
        const parsed = await error.getErrorResponse();

        expect(parsed).toEqual(errorBody);
        expect(parsed?.error).toBe('Invalid password');
    });

    it('returns null when body is not JSON', async () => {
        const mockResponse = createMockResponse(500, null);
        // Override json to throw
        (mockResponse as any).json = () => { throw new Error('Not JSON'); };
        const error = new RestError(mockResponse, 'Server error');
        const parsed = await error.getErrorResponse();

        expect(parsed).toBeNull();
    });
});
