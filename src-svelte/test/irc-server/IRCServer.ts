import * as net from 'net';
import type { ClientState, Channel, ServerOpts, ParsedIrcLine, ControlCommand } from './types';
import * as N from './numerics';

function parseIrcLine(line: string): ParsedIrcLine | null {
  let rest = line.trim();
  if (!rest) return null;
  let prefix: string | undefined;
  if (rest.startsWith(':')) {
    const idx = rest.indexOf(' ');
    if (idx === -1) return null;
    prefix = rest.slice(1, idx);
    rest = rest.slice(idx + 1);
  }
  const params: string[] = [];
  const trailingIdx = rest.indexOf(' :');
  if (trailingIdx !== -1) {
    const before = rest.slice(0, trailingIdx);
    for (const p of before.split(' ')) { if (p) params.push(p); }
    params.push(rest.slice(trailingIdx + 2));
  } else {
    for (const p of rest.split(' ')) { if (p) params.push(p); }
  }
  if (params.length === 0) return null;
  const command = params.shift()!;
  return { prefix, command, params };
}

export class IRCServer {
  private opts: ServerOpts;
  private ircServer: net.Server | null = null;
  private controlServer: net.Server | null = null;
  private clients: Map<number, ClientState> = new Map();
  private channels: Map<string, Channel> = new Map();
  private sockets: Map<number, net.Socket> = new Map();
  private buffers: Map<number, string> = new Map();
  private nextId = 0;
  private botId = -1;

  constructor(opts: Partial<ServerOpts> = {}) {
    this.opts = {
      ircPort: 6667,
      controlPort: 16667,
      serverHost: '127.0.0.1',
      serverName: 'gb-test-irc',
      botNick: 'gbbot',
      botUser: 'gbbot',
      botRealname: 'Glowing Bear Test Bot',
      autoChannel: '#glowing-bear',
      welcomeMessage: 'Well met!',
      ...opts,
    };
  }

  start(): void {
    this.initBot();
    this.startIrcServer();
    this.startControlServer();
  }

  stop(): void {
    for (const [id, client] of this.clients) {
      if (id === this.botId) continue;
      for (const ch of [...client.channels]) {
        const msg = N.quit(client.nick, client.user, client.host, 'Server shutting down');
        this.broadcastToChannel(ch, msg, id);
      }
      const sock = this.sockets.get(id);
      if (sock) { try { sock.end(); sock.destroy(); } catch { /* ignore */ } }
    }
    if (this.ircServer) this.ircServer.close();
    if (this.controlServer) this.controlServer.close();
  }

  getServerName(): string { return this.opts.serverName; }
  getAutoChannel(): string { return this.opts.autoChannel; }
  getBotNick(): string { return this.opts.botNick; }

  /* ─── Bot ──────────────────────────────────────────────────────────── */

  private initBot(): void {
    const id = this.nextId++;
    this.botId = id;
    this.clients.set(id, {
      id, nick: this.opts.botNick, user: this.opts.botUser,
      realname: this.opts.botRealname, host: '127.0.0.1',
      registered: true, channels: new Set(),
    });
    this.addClientToChannel(id, this.opts.autoChannel);
  }

  /* ─── IRC Server ────────────────────────────────────────────────────── */

  private startIrcServer(): void {
    this.ircServer = net.createServer((socket) => this.onIrcConnection(socket));
    this.ircServer.listen(this.opts.ircPort, this.opts.serverHost, () => {
      process.stdout.write(`IRC server listening on ${this.opts.serverHost}:${this.opts.ircPort}\n`);
    });
  }

  private onIrcConnection(socket: net.Socket): void {
    const id = this.nextId++;
    socket.setKeepAlive(true, 30);
    this.clients.set(id, { id, nick: '', user: '', realname: '', host: socket.remoteAddress || '127.0.0.1', registered: false, channels: new Set() });
    this.sockets.set(id, socket);
    this.buffers.set(id, '');

    socket.on('data', (data) => this.onIrcData(id, data as Buffer));
    socket.on('close', () => this.onIrcClose(id));
    socket.on('error', () => this.onIrcClose(id));
  }

  private onIrcData(clientId: number, data: Buffer): void {
    const prev = this.buffers.get(clientId) || '';
    const full = prev + data.toString('utf-8');
    const lines = full.split('\r\n');
    this.buffers.set(clientId, lines.pop() || '');
    for (const line of lines) {
      if (line.length > 0) this.handleIrcLine(clientId, line);
    }
  }

  private onIrcClose(clientId: number): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (client.registered) {
      const msg = N.quit(client.nick, client.user, client.host, 'Connection closed');
      for (const ch of [...client.channels]) {
        this.broadcastToChannel(ch, msg, clientId);
        this.removeClientFromChannel(clientId, ch);
      }
    }
    this.clients.delete(clientId);
    this.sockets.delete(clientId);
    this.buffers.delete(clientId);
  }

  /* ─── IRC Line Dispatch ──────────────────────────────────────────── */

  private handleIrcLine(clientId: number, line: string): void {
    const parsed = parseIrcLine(line);
    if (!parsed) return;
    const { command, params } = parsed;

    switch (command.toUpperCase()) {
      case 'CAP': this.handleCap(clientId, params); break;
      case 'AUTHENTICATE': break;
      case 'NICK': if (params.length >= 1) this.handleNick(clientId, params[0]); break;
      case 'USER': if (params.length >= 4) this.handleUser(clientId, params[0], params[3]); break;
      case 'JOIN': this.handleJoin(clientId, params[0]?.split(',') || []); break;
      case 'PART': this.handlePart(clientId, params[0] || '', params.slice(1).join(' ')); break;
      case 'PRIVMSG': if (params.length >= 2) this.handlePrivmsg(clientId, params[0], params[1]); break;
      case 'NOTICE': if (params.length >= 2) this.handleNotice(clientId, params[0], params[1]); break;
      case 'QUIT': this.handleQuit(clientId, params.join(' ')); break;
      case 'PING': this.handlePing(clientId, params[0] || ''); break;
      case 'PONG': break;
      case 'TOPIC': this.handleTopic(clientId, params[0] || '', params.slice(1).join(' ')); break;
      case 'ISON': break;
      case 'WHOIS': break;
      case 'MODE': break;
      case 'LUSERS': break;
      case 'MOTD': break;
      case 'VERSION': break;
      case 'ADMIN': break;
      case 'TIME': break;
      case 'INFO': break;
      case 'SQUIT': break;
      case 'CONNECT': break;
      case 'DIE': break;
      case 'RESTART': break;
      case 'SERVICE': break;
      case 'OPER': break;
      case 'WALLOPS': break;
      case 'USERHOST': break;
      case 'NJOIN': break;
      case 'SERVER': break;
      case 'KILL': break;
      case 'REHASH': break;
      case 'RESTORE': break;
      case 'SETNAME': break;
    }
  }

  /* ─── IRC Handlers ──────────────────────────────────────────────────── */

  private handleCap(clientId: number, params: string[]): void {
    const sub = params[0]?.toUpperCase();
    if (sub === 'LS') {
      this.sendToClient(clientId, `:${this.opts.serverName} CAP * LS :\r\n`);
    } else if (sub === 'REQ') {
      this.sendToClient(clientId, `:${this.opts.serverName} CAP * NAK :${params.slice(1).join(' ')}\r\n`);
    }
  }

  private handleNick(clientId: number, nick: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (client.registered) {
      const existing = this.getClientByNick(nick);
      if (existing && existing.id !== clientId) return;
      const msg = N.nickChange(client.nick, client.user, client.host, nick);
      for (const ch of client.channels) this.broadcastToChannel(ch, msg);
      client.nick = nick;
    } else {
      client.nick = nick;
      this.tryRegister(clientId);
    }
  }

  private handleUser(clientId: number, user: string, realname: string): void {
    const client = this.clients.get(clientId);
    if (!client || client.registered) return;
    client.user = user;
    client.realname = realname;
    this.tryRegister(clientId);
  }

  private tryRegister(clientId: number): void {
    const client = this.clients.get(clientId);
    if (!client || client.registered || !client.nick || !client.user) return;
    client.registered = true;
    const s = this.opts.serverName;
    const nick = client.nick;
    this.sendToClient(clientId,
      N.rpl_welcome(s, nick) +
      N.rpl_yourhost(s, nick) +
      N.rpl_created(s, nick) +
      N.rpl_myinfo(s, nick) +
      N.rpl_isupport(s, nick) +
      N.rpl_luserclient(s, nick) +
      N.err_nomotd(s, nick),
    );
  }

  private handleJoin(clientId: number, channels: string[]): void {
    const s = this.opts.serverName;
    for (const raw of channels) {
      const ch = raw.trim();
      if (!ch) continue;
      this.addClientToChannel(clientId, ch);
      const client = this.clients.get(clientId);
      if (!client) continue;
      const joinMsg = N.join(client.nick, client.user, client.host, ch);
      this.broadcastToChannel(ch, joinMsg);
      this.sendToClient(clientId, joinMsg);

      const chan = this.channels.get(ch.toLowerCase());
      if (chan) {
        const nicks: string[] = [];
        for (const mid of chan.members) {
          const c = this.clients.get(mid);
          if (c) nicks.push(mid === this.botId ? '@' + c.nick : c.nick);
        }
        this.sendToClient(clientId,
          N.rpl_namreply(s, client.nick, ch, nicks) +
          N.rpl_endofnames(s, client.nick, ch),
        );
        if (chan.topic) this.sendToClient(clientId, N.rpl_topic(s, client.nick, ch, chan.topic));
        else this.sendToClient(clientId, N.rpl_notopic(s, client.nick, ch));
      }

      if (clientId !== this.botId) {
        const bot = this.clients.get(this.botId);
        if (bot && bot.channels.has(ch)) {
          const msg = N.privmsg(bot.nick, bot.user, bot.host, ch, this.opts.welcomeMessage);
          this.broadcastToChannel(ch, msg, this.botId);
        }
      }
    }
  }

  private handlePart(clientId: number, channel: string, reason: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    const msg = N.part(client.nick, client.user, client.host, channel, reason || undefined);
    this.broadcastToChannel(channel, msg);
    this.removeClientFromChannel(clientId, channel);
  }

  private handlePrivmsg(clientId: number, target: string, text: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (target.startsWith('#') || target.startsWith('&')) {
      const msg = N.privmsg(client.nick, client.user, client.host, target, text);
      this.broadcastToChannel(target, msg, clientId);
    } else {
      const targetClient = this.getClientByNick(target);
      if (targetClient && targetClient.id !== this.botId) {
        this.sendToClient(targetClient.id, N.privmsg(client.nick, client.user, client.host, target, text));
      }
    }
  }

  private handleNotice(clientId: number, target: string, text: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (target.startsWith('#') || target.startsWith('&')) {
      const msg = N.notice(client.nick, client.user, client.host, target, text);
      this.broadcastToChannel(target, msg, clientId);
    } else {
      const targetClient = this.getClientByNick(target);
      if (targetClient && targetClient.id !== this.botId) {
        this.sendToClient(targetClient.id, N.notice(client.nick, client.user, client.host, target, text));
      }
    }
  }

  private handleQuit(clientId: number, reason: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    for (const ch of [...client.channels]) {
      const msg = N.quit(client.nick, client.user, client.host, reason || 'Quit');
      this.broadcastToChannel(ch, msg, clientId);
      this.removeClientFromChannel(clientId, ch);
    }
    this.clients.delete(clientId);
    this.sockets.delete(clientId);
    this.buffers.delete(clientId);
  }

  private handlePing(clientId: number, token: string): void {
    this.sendToClient(clientId, `PONG :${token}\r\n`);
  }

  private handleTopic(clientId: number, channel: string, topic: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    const chan = this.channels.get(channel.toLowerCase());
    if (!chan) return;
    if (topic) {
      chan.topic = topic;
      const msg = N.rpl_topic(this.opts.serverName, client.nick, channel, topic);
      this.broadcastToChannel(channel, msg);
    } else {
      if (chan.topic) this.sendToClient(clientId, N.rpl_topic(this.opts.serverName, client.nick, channel, chan.topic));
      else this.sendToClient(clientId, N.rpl_notopic(this.opts.serverName, client.nick, channel));
    }
  }

  /* ─── Control API ───────────────────────────────────────────────────── */

  private startControlServer(): void {
    this.controlServer = net.createServer((socket) => this.onControlConnection(socket));
    this.controlServer.listen(this.opts.controlPort, this.opts.serverHost, () => {
      process.stdout.write(`Control API listening on ${this.opts.serverHost}:${this.opts.controlPort}\n`);
    });
  }

  private onControlConnection(socket: net.Socket): void {
    let buf = '';
    socket.on('data', (data) => {
      buf += data.toString('utf-8');
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (trimmed) this.handleControlCommand(trimmed, socket);
      }
    });
    socket.on('error', () => socket.destroy());
  }

  private handleControlCommand(line: string, socket: net.Socket): void {
    let cmd: ControlCommand;
    try { cmd = JSON.parse(line); } catch (e) {
      socket.end(JSON.stringify({ ok: false, error: String(e) }) + '\n');
      return;
    }

    const sendOk = () => { if (!socket.destroyed) socket.end(JSON.stringify({ ok: true }) + '\n'); };
    const sendErr = (msg: string) => { if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: msg }) + '\n'); };
    const bot = this.clients.get(this.botId);
    if (!bot) { sendErr('Bot not found'); return; }

    switch (cmd.cmd) {
      case 'send_message':
      case 'send_notice': {
        if (!cmd.channel || cmd.text === undefined) { sendErr('Missing channel or text'); return; }
        const fn = cmd.cmd === 'send_message' ? N.privmsg : N.notice;
        const msg = fn(bot.nick, bot.user, bot.host, cmd.channel, cmd.text);
        this.broadcastToChannel(cmd.channel, msg, this.botId);
        sendOk();
        return;
      }
      case 'colored_message': {
        if (!cmd.channel || cmd.text === undefined) { sendErr('Missing channel or text'); return; }
        const colorCode = `\x03${cmd.fg || '04'}${cmd.bg ? ',' + cmd.bg : ''}`;
        const reset = '\x03';
        const coloredText = `${colorCode}${cmd.text}${reset}`;
        const msg = N.privmsg(bot.nick, bot.user, bot.host, cmd.channel, coloredText);
        this.broadcastToChannel(cmd.channel, msg, this.botId);
        sendOk();
        return;
      }
      case 'join': {
        if (!cmd.channel) { sendErr('Missing channel'); return; }
        this.addClientToChannel(this.botId, cmd.channel);
        const joinMsg = N.join(bot.nick, bot.user, bot.host, cmd.channel);
        this.broadcastToChannel(cmd.channel, joinMsg, this.botId);
        const chan = this.channels.get(cmd.channel.toLowerCase());
        if (chan) {
          const nicks: string[] = [];
          for (const mid of chan.members) {
            const c = this.clients.get(mid);
            if (c) nicks.push(mid === this.botId ? '@' + c.nick : c.nick);
          }
          for (const mid of chan.members) {
            if (mid !== this.botId) {
              const mc = this.clients.get(mid);
              this.sendToClient(mid,
                N.rpl_namreply(this.opts.serverName, mc?.nick || '*', cmd.channel, nicks) +
                N.rpl_endofnames(this.opts.serverName, mc?.nick || '*', cmd.channel),
              );
            }
          }
        }
        sendOk();
        return;
      }
      case 'part': {
        if (!cmd.channel) { sendErr('Missing channel'); return; }
        const partMsg = N.part(bot.nick, bot.user, bot.host, cmd.channel);
        this.broadcastToChannel(cmd.channel, partMsg, this.botId);
        this.removeClientFromChannel(this.botId, cmd.channel);
        sendOk();
        return;
      }
      case 'quit': {
        for (const ch of [...bot.channels]) {
          const quitMsg = N.quit(bot.nick, bot.user, bot.host, 'Bot quitting');
          this.broadcastToChannel(ch, quitMsg, this.botId);
          this.removeClientFromChannel(this.botId, ch);
        }
        sendOk();
        return;
      }
      case 'nick': {
        if (!cmd.nickname) { sendErr('Missing nickname'); return; }
        const oldNick = bot.nick;
        const nickMsg = N.nickChange(oldNick, bot.user, bot.host, cmd.nickname);
        for (const ch of bot.channels) this.broadcastToChannel(ch, nickMsg);
        bot.nick = cmd.nickname;
        sendOk();
        return;
      }
      case 'topic': {
        if (!cmd.channel || cmd.text === undefined) { sendErr('Missing channel or text'); return; }
        const chan = this.channels.get(cmd.channel.toLowerCase());
        if (!chan) { sendErr('Channel not found'); return; }
        chan.topic = cmd.text;
        const topicMsg = N.rpl_topic(this.opts.serverName, '*', cmd.channel, cmd.text);
        for (const mid of chan.members) this.sendToClient(mid, topicMsg);
        sendOk();
        return;
      }
      case 'raw': {
        if (!cmd.raw) { sendErr('Missing raw data'); return; }
        const parts2 = cmd.raw.split(' ');
        const target = parts2[2];
        if (target && (target.startsWith('#') || target.startsWith('&'))) {
          this.broadcastToChannel(target, cmd.raw.endsWith('\r\n') ? cmd.raw : cmd.raw + '\r\n');
        }
        sendOk();
        return;
      }
      case 'send_pm': {
        if (!cmd.nick || cmd.text === undefined) { sendErr('Missing nick or text'); return; }
        const target = this.getClientByNick(cmd.nick);
        if (!target) { sendErr('Target not found'); return; }
        const msg = N.privmsg(bot.nick, bot.user, bot.host, cmd.nick, cmd.text);
        this.sendToClient(target.id, msg);
        sendOk();
        return;
      }
      default:
        sendErr(`Unknown command: ${(cmd as any).cmd}`);
    }
  }

  /* ─── Channel & Message Plumbing ────────────────────────────────────── */

  private addClientToChannel(clientId: number, channelName: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    const key = channelName.toLowerCase();
    let chan = this.channels.get(key);
    if (!chan) { chan = { name: channelName, topic: '', members: new Set() }; this.channels.set(key, chan); }
    chan.members.add(clientId);
    client.channels.add(channelName);
  }

  private removeClientFromChannel(clientId: number, channelName: string): void {
    const client = this.clients.get(clientId);
    const chan = this.channels.get(channelName.toLowerCase());
    if (!client || !chan) return;
    chan.members.delete(clientId);
    client.channels.delete(channelName);
    if (chan.members.size === 0) this.channels.delete(channelName.toLowerCase());
  }

  private broadcastToChannel(channelName: string, message: string, excludeId?: number): void {
    const chan = this.channels.get(channelName.toLowerCase());
    if (!chan) return;
    for (const mid of chan.members) {
      if (mid === excludeId) continue;
      if (mid === this.botId) continue;
      const socket = this.sockets.get(mid);
      if (socket) try { socket.write(message); } catch { /* ignore */ }
    }
  }

  private sendToClient(clientId: number, message: string): void {
    if (clientId === this.botId) return;
    const socket = this.sockets.get(clientId);
    if (socket) try { socket.write(message); } catch { /* ignore */ }
  }

  private getClientByNick(nick: string): ClientState | undefined {
    const lower = nick.toLowerCase();
    for (const c of this.clients.values()) { if (c.nick.toLowerCase() === lower) return c; }
    return undefined;
  }
}
