export interface ClientState {
  id: number;
  nick: string;
  user: string;
  realname: string;
  host: string;
  registered: boolean;
  channels: Set<string>;
}

export interface Channel {
  name: string;
  topic: string;
  members: Set<number>;
}

export interface ServerOpts {
  ircPort: number;
  controlPort: number;
  serverHost: string;
  serverName: string;
  botNick: string;
  botUser: string;
  botRealname: string;
  autoChannel: string;
  welcomeMessage: string;
}

export interface ParsedIrcLine {
  prefix?: string;
  command: string;
  params: string[];
}

export type ControlCommand =
  // `more: true` keeps the control connection open after answering, so a
  // benchmark can send a long sequence over one socket instead of one socket
  // per message.
  | { cmd: 'send_message'; channel: string; text: string; more?: boolean }
  | { cmd: 'send_notice'; channel: string; text: string; more?: boolean }
  | { cmd: 'colored_message'; channel: string; text: string; fg?: string; bg?: string }
  | { cmd: 'join'; channel: string }
  | { cmd: 'part'; channel: string }
  | { cmd: 'quit' }
  | { cmd: 'nick'; nickname: string }
  | { cmd: 'topic'; channel: string; text: string }
  | { cmd: 'mode'; channel: string; modes: string }
  | { cmd: 'raw'; raw: string }
  | { cmd: 'send_pm'; nick: string; text: string };
