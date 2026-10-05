// WeeChat Relay REST API Type Definitions
// Verified against a live WeeChat 4.10.1 / Relay API 0.6.0 session — see
// src-svelte/test/fixtures/api-dossier/ for raw frame captures and the
// OpenAPI stable schema 0.6.0. Where the shipped schema and the live server
// disagree, the live behavior wins and is noted inline.

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
    /** Buffer notify level; sent by WeeChat >= 5.0.0, absent in 4.10.1. */
    notify?: 'none' | 'highlight' | 'message' | 'all';
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

// Live: error bodies are exactly `{"error":"..."}` with HTTP-style codes on the
// surrounding frame/status; the extra fields below belong to the frame, not
// the body (see WebSocketResponse).
export interface RestErrorResponse {
    error: string;
}

// body_type values observed live (null on 204/no-body responses)
export type ApiBodyType =
    | 'buffers' | 'buffer' | 'lines' | 'line'
    | 'nick_group' | 'nick' | 'hotlist' | 'completion' | 'scripts' | 'json';

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

// Event names observed live on 4.10.1 (buffer_modes_changed and
// input_prompt_changed exist in source but are absent from the manual table).
// The union stays open (`string & {}`) because WeeChat may add events.
export type ApiEventName =
    | 'buffer_opened' | 'buffer_closing' | 'buffer_closed'
    | 'buffer_title_changed' | 'buffer_localvar_added' | 'buffer_localvar_changed' | 'buffer_localvar_removed'
    | 'buffer_modes_changed' | 'buffer_cleared' | 'buffer_renamed' | 'buffer_hidden' | 'buffer_unhidden'
    | 'buffer_type_changed' | 'buffer_types_changed' | 'buffer_moved' | 'buffer_merged' | 'buffer_unmerged'
    | 'buffer_time_for_each_line_changed' | 'buffer_notify_changed' | 'buffer_notify_default_changed'
    | 'buffer_line_added' | 'buffer_line_data_changed'
    | 'nicklist_group_added' | 'nicklist_group_removed' | 'nicklist_group_moved'
    | 'nicklist_group_changed' | 'nicklist_group_removing'
    | 'nicklist_nick_added' | 'nicklist_nick_removed' | 'nicklist_nick_moved'
    | 'nicklist_nick_removing' | 'nicklist_nick_changed'
    | 'input_text_changed' | 'input_text_cursor_moved' | 'input_prompt_changed'
    | 'hotlist_changed' | 'hotlist_removed'
    | 'upgrade' | 'upgrade_ended' | 'quit'
    | (string & {});

export interface WebSocketEvent {
    code: 0;
    message: 'Event';
    event_name: ApiEventName;
    buffer_id: number;
    body_type: ApiBodyType | null;
    body: unknown;
}
