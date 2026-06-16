import type {
    HashAlgorithm,
    HandshakeRequest,
    HandshakeResponse,
    VersionResponse,
    RestBuffer,
    BufferQueryOptions,
    RestLine,
    LineQueryOptions,
    RestNickGroup,
    RestNickGroupRoot,
    RestNick,
    RestHotlistEntry,
    RestScript,
    InputRequest,
    CompletionRequest,
    CompletionResponse,
    PingRequest,
    PingResponse,
    RestErrorResponse
} from './weechat-rest-types';

export type {
    HashAlgorithm,
    HandshakeRequest,
    HandshakeResponse,
    VersionResponse,
    RestBuffer,
    BufferQueryOptions,
    RestLine,
    LineQueryOptions,
    RestNickGroup,
    RestNickGroupRoot,
    RestNick,
    RestHotlistEntry,
    RestScript,
    InputRequest,
    CompletionRequest,
    CompletionResponse,
    PingRequest,
    PingResponse,
    RestErrorResponse
};

export type AuthAlgo = 'plain' | 'sha256' | 'sha512' | 'pbkdf2+sha256' | 'pbkdf2+sha512';

const API_BASE = '/api';

function buildAuthHeader(algo: AuthAlgo, password: string, totp?: string): Record<string, string> {
    const authValue = algo === 'plain' ? `plain:${password}` : `${algo}:${password}`;
    return {
        Authorization: `Basic ${btoa(authValue)}`,
        ...(totp ? { 'X-WeeChat-TOTP': totp } : {})
    };
}

function buildHashedAuthHeader(
    algo: Extract<AuthAlgo, 'sha256' | 'sha512'>,
    password: string,
    timestamp: number
): Promise<{ header: Record<string, string>; timestamp: number }> {
    const timestampStr = timestamp.toString();
    const data = timestampStr + password;
    return crypto.subtle.digest(algo.toUpperCase(), new TextEncoder().encode(data))
        .then((hashBuffer) => {
            const hashHex = Array.from(new Uint8Array(hashBuffer))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            const authValue = `hash:${algo}:${timestamp}:${hashHex}`;
            return {
                header: { Authorization: `Basic ${btoa(authValue)}` },
                timestamp
            };
        });
}

function buildPbkdf2AuthHeader(
    password: string,
    iterations: number,
    timestamp: number,
    hashName: 'SHA-256' | 'SHA-512' = 'SHA-256'
): Promise<{ header: Record<string, string>; timestamp: number }> {
    return crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
    ).then((key) => {
        const salt = new TextEncoder().encode(timestamp.toString());
        const bits = hashName === 'SHA-512' ? 512 : 256;
        return crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt, iterations, hash: hashName },
            key,
            bits
        );
    }).then((derivedBits) => {
        const hashHex = Array.from(new Uint8Array(derivedBits))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        const algoSuffix = hashName === 'SHA-512' ? 'pbkdf2+sha512' : 'pbkdf2+sha256';
        const authValue = `hash:${algoSuffix}:${timestamp}:${iterations}:${hashHex}`;
        return {
            header: { Authorization: `Basic ${btoa(authValue)}` },
            timestamp
        };
    });
}

export class WeeChatRest {
    private _baseUrl: string;
    private _handshakeResult: HandshakeResponse | null = null;
    private _totp: string | null = null;

    constructor(baseUrl: string = '') {
        this._baseUrl = baseUrl.replace(/\/+$/, '');
    }

    get baseUrl(): string {
        return this._baseUrl;
    }

    setBaseUrl(url: string): void {
        this._baseUrl = url.replace(/\/+$/, '');
    }

    setTOTP(totp: string | null): void {
        this._totp = totp;
    }

    getHandshakeResult(): HandshakeResponse | null {
        return this._handshakeResult;
    }

    async handshake(request?: HandshakeRequest): Promise<HandshakeResponse> {
        const response = await fetch(`${this._baseUrl}${API_BASE}/handshake`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: request ? JSON.stringify(request) : undefined
        });
        if (!response.ok) {
            throw new Error(`Handshake failed: ${response.status} ${response.statusText}`);
        }
        const result = await response.json() as HandshakeResponse;
        this._handshakeResult = result;
        return result;
    }

    async getVersion(): Promise<VersionResponse> {
        const response = await fetch(`${this._baseUrl}${API_BASE}/version`);
        if (!response.ok) {
            throw new RestError(response, 'Failed to get version');
        }
        return response.json() as Promise<VersionResponse>;
    }

    private buildAuthHeaders(algo: AuthAlgo, password: string): Promise<Record<string, string>> {
        if (algo === 'plain') {
            return Promise.resolve(buildAuthHeader(algo, password, this._totp ?? undefined));
        }
        if (algo === 'sha256' || algo === 'sha512') {
            const ts = Math.floor(Date.now() / 1000);
            return buildHashedAuthHeader(algo, password, ts)
                .then((result) => ({ ...result.header, ...(this._totp ? { 'X-WeeChat-TOTP': this._totp! } : {}) }));
        }
        const iterations = this._handshakeResult?.password_hash_iterations ?? 100000;
        const ts = Math.floor(Date.now() / 1000);
        const hashName = algo === 'pbkdf2+sha512' ? 'SHA-512' : 'SHA-256';
        return buildPbkdf2AuthHeader(password, iterations, ts, hashName)
            .then((result) => ({ ...result.header, ...(this._totp ? { 'X-WeeChat-TOTP': this._totp! } : {}) }));
    }

    async getBuffers(options?: BufferQueryOptions): Promise<RestBuffer[]> {
        const url = new URL(`${this._baseUrl}${API_BASE}/buffers`);
        if (options) {
            if (options.lines !== undefined) url.searchParams.set('lines', options.lines.toString());
            if (options.lines_free !== undefined) url.searchParams.set('lines_free', options.lines_free.toString());
            if (options.nicks) url.searchParams.set('nicks', 'true');
            if (options.colors) url.searchParams.set('colors', options.colors);
        }
        const response = await fetch(url.toString());
        if (!response.ok) {
            throw new RestError(response, 'Failed to get buffers');
        }
        return response.json() as Promise<RestBuffer[]>;
    }

    async getBufferById(bufferId: number, options?: BufferQueryOptions): Promise<RestBuffer> {
        const url = new URL(`${this._baseUrl}${API_BASE}/buffers/${bufferId}`);
        if (options) {
            if (options.lines !== undefined) url.searchParams.set('lines', options.lines.toString());
            if (options.lines_free !== undefined) url.searchParams.set('lines_free', options.lines_free.toString());
            if (options.nicks) url.searchParams.set('nicks', 'true');
            if (options.colors) url.searchParams.set('colors', options.colors);
        }
        const response = await fetch(url.toString());
        if (!response.ok) {
            throw new RestError(response, `Failed to get buffer ${bufferId}`);
        }
        return response.json() as Promise<RestBuffer>;
    }

    async getBufferByName(bufferName: string, options?: BufferQueryOptions): Promise<RestBuffer> {
        const url = new URL(`${this._baseUrl}${API_BASE}/buffers/${encodeURIComponent(bufferName)}`);
        if (options) {
            if (options.lines !== undefined) url.searchParams.set('lines', options.lines.toString());
            if (options.lines_free !== undefined) url.searchParams.set('lines_free', options.lines_free.toString());
            if (options.nicks) url.searchParams.set('nicks', 'true');
            if (options.colors) url.searchParams.set('colors', options.colors);
        }
        const response = await fetch(url.toString());
        if (!response.ok) {
            throw new RestError(response, `Failed to get buffer ${bufferName}`);
        }
        return response.json() as Promise<RestBuffer>;
    }

    async getLines(bufferId: number, options?: LineQueryOptions): Promise<RestLine[]> {
        const url = new URL(`${this._baseUrl}${API_BASE}/buffers/${bufferId}/lines`);
        if (options) {
            if (options.lines !== undefined) url.searchParams.set('lines', options.lines.toString());
            if (options.colors) url.searchParams.set('colors', options.colors);
        }
        const response = await fetch(url.toString());
        if (!response.ok) {
            throw new RestError(response, `Failed to get lines for buffer ${bufferId}`);
        }
        return response.json() as Promise<RestLine[]>;
    }

    async getLinesByBufferName(bufferName: string, options?: LineQueryOptions): Promise<RestLine[]> {
        const url = new URL(`${this._baseUrl}${API_BASE}/buffers/${encodeURIComponent(bufferName)}/lines`);
        if (options) {
            if (options.lines !== undefined) url.searchParams.set('lines', options.lines.toString());
            if (options.colors) url.searchParams.set('colors', options.colors);
        }
        const response = await fetch(url.toString());
        if (!response.ok) {
            throw new RestError(response, `Failed to get lines for buffer ${bufferName}`);
        }
        return response.json() as Promise<RestLine[]>;
    }

    async getSingleLine(bufferId: number, lineId: number): Promise<RestLine> {
        const response = await fetch(`${this._baseUrl}${API_BASE}/buffers/${bufferId}/lines/${lineId}`);
        if (!response.ok) {
            throw new RestError(response, `Failed to get line ${lineId} from buffer ${bufferId}`);
        }
        return response.json() as Promise<RestLine>;
    }

    async getNicks(bufferId: number): Promise<RestNickGroupRoot> {
        const response = await fetch(`${this._baseUrl}${API_BASE}/buffers/${bufferId}/nicks`);
        if (!response.ok) {
            throw new RestError(response, `Failed to get nicks for buffer ${bufferId}`);
        }
        return response.json() as Promise<RestNickGroupRoot>;
    }

    async getNicksByName(bufferName: string): Promise<RestNickGroupRoot> {
        const response = await fetch(`${this._baseUrl}${API_BASE}/buffers/${encodeURIComponent(bufferName)}/nicks`);
        if (!response.ok) {
            throw new RestError(response, `Failed to get nicks for buffer ${bufferName}`);
        }
        return response.json() as Promise<RestNickGroupRoot>;
    }

    async getHotlist(): Promise<RestHotlistEntry[]> {
        const response = await fetch(`${this._baseUrl}${API_BASE}/hotlist`);
        if (!response.ok) {
            throw new RestError(response, 'Failed to get hotlist');
        }
        return response.json() as Promise<RestHotlistEntry[]>;
    }

    async sendInput(request: InputRequest): Promise<void> {
        const body: Record<string, unknown> = { command: request.command };
        if (request.buffer_id !== undefined) body.buffer_id = request.buffer_id;
        if (request.buffer_name !== undefined) body.buffer_name = request.buffer_name;
        const response = await fetch(`${this._baseUrl}${API_BASE}/input`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            throw new RestError(response, 'Failed to send input');
        }
    }

    async getCompletions(request: CompletionRequest): Promise<CompletionResponse> {
        const body: Record<string, unknown> = {
            command: request.command
        };
        if (request.buffer_id !== undefined) body.buffer_id = request.buffer_id;
        if (request.buffer_name !== undefined) body.buffer_name = request.buffer_name;
        if (request.position !== undefined) body.position = request.position;
        const response = await fetch(`${this._baseUrl}${API_BASE}/completion`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            throw new RestError(response, 'Failed to get completions');
        }
        return response.json() as Promise<CompletionResponse>;
    }

    async ping(request?: PingRequest): Promise<PingResponse> {
        let body: string | undefined;
        if (request?.data !== undefined) {
            body = JSON.stringify({ data: request.data });
        }
        const response = await fetch(`${this._baseUrl}${API_BASE}/ping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
        });
        if (!response.ok) {
            throw new RestError(response, 'Ping failed');
        }
        // 204 No Content when no data was sent
        if (response.status === 204) {
            return { data: '' };
        }
        return response.json() as Promise<PingResponse>;
    }

    async getScripts(): Promise<RestScript[]> {
        const response = await fetch(`${this._baseUrl}${API_BASE}/scripts`);
        if (!response.ok) {
            throw new RestError(response, 'Failed to get scripts');
        }
        return response.json() as Promise<RestScript[]>;
    }

    async authenticate(algo: AuthAlgo, password: string): Promise<void> {
        // Handshake first if not done
        if (!this._handshakeResult) {
            await this.handshake({ password_hash_algo: [algo] });
        }
        this._authHeaders = await this.buildAuthHeaders(algo, password);
    }

    private _authHeaders: Record<string, string> = {};

    private async _fetchWithAuth(url: string, options?: RequestInit): Promise<Response> {
        const headers = {
            ...options?.headers,
            ...this._authHeaders
        };
        return fetch(url, { ...options, headers });
    }
}

export class RestError extends Error {
    constructor(
        public readonly response: Response,
        message: string
    ) {
        super(message);
        this.name = 'RestError';
    }

    async getErrorResponse(): Promise<RestErrorResponse | null> {
        try {
            return await this.response.json() as Promise<RestErrorResponse>;
        } catch {
            return null;
        }
    }
}
