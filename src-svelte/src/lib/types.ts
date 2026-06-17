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
    local_variables: {
        type?: string;
        plugin?: string;
        server?: string;
        pinned?: string;
    };
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
    highlight: number;
}

// Nick message from protocol
export interface NickMessage {
    pointers: string[];
    prefix: string;
    visible: string;
    name: string;
    color?: string;
    prefix_color?: string;
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
    metadata?: PluginMetadata[];
}

export interface Nick {
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
    lastSeen: number;
    unread: number;
    notification: number;
    notify: number;
    nicklist: Record<string, NickGroup>;
    serverSortKey: string;
    indent: boolean;
    bufferType: number;
    type: BufferType;
    plugin: string;
    server: string;
    hideBufferLineTimes: boolean;
    pinned: boolean;
    active: boolean;
    $jumpKey?: string;
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
    enableMathjax: boolean;
    enableQuickKeys: boolean;
    showNicklist: boolean;
    showQuickKeys: boolean;
    showJumpKeys: boolean;
    highlightWords: string;
    angularTimeFormat?: string;
    supports_formatting_date?: boolean;
}

// ---- Plugin Embeds ----

export interface PluginMetadata {
    content: string | (() => void);
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
