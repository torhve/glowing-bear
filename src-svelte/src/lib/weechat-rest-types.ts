// WeeChat Relay REST API Type Definitions
// Based on doc/weechat_relay_api.en.adoc

// --- Authentication ---

export type HashAlgorithm = 'plain' | 'sha256' | 'sha512' | 'pbkdf2+sha256' | 'pbkdf2+sha512';

export interface HandshakeRequest {
    password_hash_algo?: HashAlgorithm[];
}

export interface HandshakeResponse {
    password_hash_algo: string | null;
    password_hash_iterations: number;
    totp: boolean;
}

// --- Version ---

export interface VersionResponse {
    weechat_version: string;
    weechat_version_git: string;
    weechat_version_number: number;
    relay_api_version: string;
    relay_api_version_number: number;
}

// --- Buffers ---

export interface RestBuffer {
    id: number;
    name: string;
    short_name: string;
    number: number;
    type: 'formatted' | 'free';
    hidden: boolean;
    title: string;
    modes: string;
    input_prompt: string;
    input: string;
    input_position: number;
    input_multiline: boolean;
    nicklist: boolean;
    nicklist_case_sensitive: boolean;
    nicklist_display_groups: boolean;
    time_displayed: boolean;
    local_variables: Record<string, string>;
    keys: Array<{ key: string; command: string }>;
    last_read_line_id: number;
    lines?: RestLine[];
    nicklist_root?: RestNickGroup;
}

export interface BufferQueryOptions {
    lines?: number;
    lines_free?: number;
    nicks?: boolean;
    colors?: 'ansi' | 'weechat' | 'strip';
}

// --- Lines ---

export interface RestLine {
    id: number;
    y: number;
    date: string;
    date_printed: string;
    displayed: boolean;
    highlight: boolean;
    notify_level: number;
    prefix: string;
    message: string;
    tags: string[];
}

export interface LineQueryOptions {
    lines?: number;
    colors?: 'ansi' | 'weechat' | 'strip';
}

// --- Nicks ---

export interface RestNickGroup {
    id: number;
    parent_group_id: number;
    name: string;
    color_name: string;
    color: string;
    visible: boolean;
    groups: RestNickGroup[];
    nicks: RestNick[];
}

export interface RestNick {
    id: number;
    parent_group_id: number;
    prefix: string;
    prefix_color_name: string;
    prefix_color: string;
    name: string;
    color_name: string;
    color: string;
    visible: boolean;
}

export interface RestNickGroupRoot {
    id: number;
    parent_group_id: number;
    name: string;
    color_name: string;
    color: string;
    visible: boolean;
    groups: RestNickGroup[];
    nicks: RestNick[];
}

// --- Hotlist ---

export interface RestHotlistEntry {
    priority: number;
    date: string;
    buffer_id: number;
    count: number[];
}

// --- Scripts ---

export interface RestScript {
    name: string;
    version: string;
    description: string;
    author: string;
    license: string;
}

// --- Input ---

export interface InputRequest {
    buffer_id?: number;
    buffer_name?: string;
    command: string;
}

// --- Completion ---

export interface CompletionRequest {
    buffer_id?: number;
    buffer_name?: string;
    command: string;
    position?: number;
}

export interface CompletionResponse {
    context: string;
    base_word: string;
    position_replace: number;
    add_space: boolean;
    list: string[];
}

// --- Ping ---

export interface PingRequest {
    data?: string;
}

export interface PingResponse {
    data: string;
}

// --- Sync (WebSocket only) ---

export interface SyncRequest {
    sync?: boolean;
    nicks?: boolean;
    input?: boolean;
    colors?: 'ansi' | 'weechat' | 'strip';
}

// --- Error Response ---

export interface RestErrorResponse {
    error: string;
    code?: number;
    message?: string;
    request?: string;
    request_body?: unknown;
    body_type?: string | null;
    body?: unknown;
}

// --- WebSocket Frame Types (for reference, not used in REST) ---

export interface WebSocketRequest {
    request: string;
    body?: unknown;
    request_id?: string;
}

export interface WebSocketResponse {
    code: number;
    message: string;
    request: string;
    request_body: unknown;
    request_id: string | null;
    body_type: string | null;
    body: unknown;
}

export interface WebSocketEvent {
    code: 0;
    message: 'Event';
    event_name: string;
    buffer_id: number;
    body_type: string | null;
    body: unknown;
}
