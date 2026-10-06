// WeeChat protocol color types
export type ColorType = 'option' | 'weechat' | 'ext';

export interface ColorInfo {
    type: ColorType;
    name: string;
}

export interface TextAttrs {
    name: string | null;
    override: Record<string, boolean>;
}

export interface RichTextPart {
    text: string;
    fgColor: ColorInfo;
    bgColor: ColorInfo;
    attrs: TextAttrs;
    classes?: string[];
    $$hashKey?: string;
}

// Buffer types from WeeChat
export type BufferType = 'server' | 'channel' | 'private' | 'query' | 'channel_temp' | 'other' | 'relay';

// Buffer message types from protocol
export interface BufferMessage {
    pointers: string[];
    full_name: string;
    short_name: string;
    title: RichTextPart[];
    hidden: number;
    number: number;
    type: number;
    notify?: number;
    local_variables?: Record<string, string>;
}

// Buffer line message from protocol
export interface BufferLineMessage {
    buffer: string;
    date: number;
    date_long: number;
    prefix?: string;
    message: string;
    tags_array: string[];
    displayed: number;
    notify_level: number;
    highlight: number;
    // WeeChat 4.3+ may provide a stable line id; older relays omit it.
    id?: string | number;
}

// Nick message from protocol
export interface NickMessage {
    pointers: string[];
    prefix: string;
    visible: string;
    name: string;
    color?: string;
    prefix_color?: string;
    _diff?: number;
}

// Nicklist group message
export interface NickGroupMessage {
    pointers: string[];
    name: string;
    visible: string;
    group: number;
    _diff?: number;
}

// Hotlist entry
export interface HotlistEntry {
    buffer: string;
    count: number[]; // [index0, message, private, highlight]
}

// Version info from WeeChat
export interface VersionInfo {
    value: string;
}

// Configuration value
export interface ConfigValue {
    full_name: string;
    value: string;
}

// Completion result
export interface CompletionResult {
    type: number;
    text: string;
    cursor: number;
    replacement_start: number;
    replacement_end: number;
}

// ---- Domain Models ----

export interface BufferLine {
    prefix: RichTextPart[];
    content: RichTextPart[];
    date: number;
    shortTime: string;
    formattedTime: string;
    buffer: string;
    tags: string[];
    highlight: boolean;
    displayed: boolean;
    prefixtext: string;
    text: string;
    showHiddenBrackets: boolean;
    /** Stable identity used to remap the read boundary across line-array changes. */
    lineId?: string;
    /** WeeChat notify level, retained separately from user-message classification. */
    notifyLevel?: number;
    /** True for PRIVMSG/actions/notices and message lines in non-IRC buffers. */
    isUserMessage?: boolean;
    /** Synthetic day separators are display rows, never user messages. */
    isDateSeparator?: boolean;
    metadata?: PluginMetadata[];
}

export interface Nick {
    /** Relay API nick id; lets nickChanged/nickRemoved locate the nick. */
    nickId?: number;
    prefix: string;
    visible: string;
    name: string;
    prefixClasses: string[];
    nameClasses: string[];
    buffer: string;
    spokeAt?: number;
}

export interface NickGroup {
    name: string;
    visible: string;
    nicks: Nick[];
}

export interface ServerInfo {
    id: string;
    unread: number;
}

export interface BufferData {
    id: string;
    /** Branded numeric Relay API id; authoritative for API calls. Store key
     *  `id` is always `String(apiBufferId)` — set only by api-store-reducers. */
    apiBufferId?: number;
    /** Increments on every buffer clear; delayed history responses captured
     *  under an older epoch must be rejected. */
    clearEpoch?: number;
    fullName: string;
    shortName: string;
    hidden: boolean;
    trimmedName: string | null;
    nameClasses: string[];
    prefix: string;
    number: number;
    title: RichTextPart[];
    rtitle: string;
    lines: BufferLine[];
    requestedLines: number;
    allLinesFetched: boolean;
    /** Legacy array index retained for compatibility with callers and diagnostics. */
    lastSeen: number;
    /** True when the exact read boundary is known; false means reconnect ambiguity. */
    readBoundaryKnown?: boolean;
    /** Identity of the last read line; null means every retained line is unread. */
    readBoundaryId?: string | null;
    /** Hotlist count retained while more history is needed to infer an initial boundary. */
    pendingReadBoundaryUnread?: number;
    /**
     * WeeChat's own read marker as reported by the API transport
     * (`buffer.last_read_line_id`): >= 0 is a line id, -1 means WeeChat has no
     * marker, undefined means the transport never reported one (legacy protocol).
     * Remembered because a bootstrap snapshot taken with `lines=0` can never
     * contain the marker line, so the boundary must be re-anchored once history
     * reaches it.
     */
    serverReadLineId?: number;
    localUnread: number;
    unread: number;
    notification: number;
    notify: number;
    nicklist: Record<string, NickGroup>;
    localVariables?: Record<string, string>;
    serverSortKey: string;
    indent: boolean;
    bufferType: number;
    type: BufferType;
    plugin: string;
    server: string;
    hideBufferLineTimes: boolean;
    pinned: boolean;
    active: boolean;
}

// ---- Pending navigation ----

// A requested auto-switch: WeeChat opens the target buffer asynchronously, so
// the app remembers what the user asked for until the buffer arrives. The nick
// alone is not enough — two IRC servers can each open a query buffer for the
// same nick — and `requestId` identifies one request so an older timeout cannot
// clear a newer identical request.
export interface PendingQuery {
    nick: string;
    /** IRC server the request came from; null means the context is unknown. */
    server: string | null;
    requestId: number;
}
// ---- Connection ----

export interface ConnectionConfig {
    host: string;
    port: number;
    path: string;
    password: string;
    tls: boolean;
    noCompression: boolean;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ConnectionError {
    passwordError: boolean;
    tlsError: boolean;
    securityError: boolean;
    oldWeechatError: boolean;
    hashAlgorithmDisagree: boolean;
    errorMessage: boolean;
    uploadError: boolean;
    serverUnreachable: boolean;
}

// ---- Settings ----

export interface Settings {
    hostField: string;
    port: string;
    tls: boolean;
    password: string;
    savepassword: boolean;
    autoconnect: boolean;
    useTotp: boolean;
    theme: string;
    fontfamily: string;
    fontsize: string;
    customCSS: string;
    iToken: string;
    iAlb: string;
    onlyUnread: boolean;
    noembed: boolean;
    alwaysnicklist: boolean;
    orderbyserver: boolean;
    readlineBindings: boolean;
    useFavico: boolean;
    soundnotification: boolean;
    notificationPermission: 'granted' | 'denied' | 'default';
    enableMathjax: boolean;
    enableQuickKeys: boolean;
    showNicklist: boolean;
    showQuickKeys: boolean;
    highlightWords: string;
    debugBuildMetadata: boolean;
    hotlistsync: boolean;
    stylizePrivateChats: boolean;
    enableEmojify: boolean;
    enableFormatting: boolean;
    /** Relay transport selection: 'auto' probes the API handshake and falls
     *  back to the legacy WebSocket protocol for WeeChat < 4.10.1. */
    protocol: 'auto' | 'api' | 'legacy';
    angularTimeFormat?: string;
    supports_formatting_date?: boolean;
}

// ---- Plugin Embeds ----

// Context object passed to embed callback functions via `fn.call(context)`.
// Callbacks use `this.getElement()` to get the DOM container for injection.
export interface EmbedCallbackContext {
    getElement: () => HTMLDivElement | null;
}

export interface PluginMetadata {
    content: string | ((this: EmbedCallbackContext) => void);
    nsfw: boolean;
    name: string;
    className: string;
    visible: boolean;
}

// ---- Messages ----

/* eslint-disable @typescript-eslint/no-explicit-any -- WeeChat protocol content types are dynamic */
export interface ProtocolMessage {
    id: string;
    objects: {
        pointer: string;
        content: any[];
    }[];
}

export interface WebSocketResponse {
    objects: {
        content: any[];
    }[];
}
/* eslint-enable @typescript-eslint/no-explicit-any */
