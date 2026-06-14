export function fmt(source: string, command: string | number, ...args: string[]): string {
  const cmd = typeof command === 'number' ? String(command).padStart(3, '0') : command;
  if (args.length === 0) return `:${source} ${cmd}\r\n`;
  const last = args[args.length - 1];
  const rest = args.slice(0, -1);
  let line = `:${source} ${cmd}`;
  for (const r of rest) line += ` ${r}`;
  line += ` :${last}\r\n`;
  return line;
}

export function rpl_welcome(server: string, nick: string): string {
  return fmt(server, 1, nick, `Welcome to the Glowing Bear Test IRC Network, ${nick}!`);
}

export function rpl_yourhost(server: string, nick: string): string {
  return fmt(server, 2, nick, `Your host is ${server}, running version 1.0`);
}

export function rpl_created(server: string, nick: string): string {
  return fmt(server, 3, nick, 'This server was created 2024');
}

export function rpl_myinfo(server: string, nick: string): string {
  return fmt(server, 4, nick, `${server} 1.0 ao o`);
}

export function rpl_isupport(server: string, nick: string): string {
  return fmt(server, 5, nick, 'CHANTYPES=# CHANMODES=,,, PREFIX=(ov)@+ CASEMAPPING=ascii NICKLEN=32', 'are supported by this server');
}

export function rpl_luserclient(server: string, nick: string): string {
  return fmt(server, 251, nick, 'There are 1 users and 0 invisible on 1 server');
}

export function rpl_notopic(server: string, nick: string, channel: string): string {
  return fmt(server, 331, nick, channel, 'No topic is set');
}

export function rpl_topic(server: string, nick: string, channel: string, topic: string): string {
  return fmt(server, 332, nick, channel, topic);
}

export function rpl_namreply(server: string, nick: string, channel: string, names: string[]): string {
  return fmt(server, 353, nick, '=', channel, names.join(' '));
}

export function rpl_endofnames(server: string, nick: string, channel: string): string {
  return fmt(server, 366, nick, channel, 'End of /NAMES list.');
}

export function err_nomotd(server: string, nick: string): string {
  return fmt(server, 422, nick, 'MOTD File is missing');
}

export function join(nick: string, user: string, host: string, channel: string): string {
  return fmt(`${nick}!${user}@${host}`, 'JOIN', channel);
}

export function part(nick: string, user: string, host: string, channel: string, reason?: string): string {
  return fmt(`${nick}!${user}@${host}`, 'PART', channel, reason || 'Leaving');
}

export function quit(nick: string, user: string, host: string, reason: string): string {
  return fmt(`${nick}!${user}@${host}`, 'QUIT', reason);
}

export function privmsg(nick: string, user: string, host: string, target: string, text: string): string {
  return fmt(`${nick}!${user}@${host}`, 'PRIVMSG', target, text);
}

export function notice(nick: string, user: string, host: string, target: string, text: string): string {
  return fmt(`${nick}!${user}@${host}`, 'NOTICE', target, text);
}

export function nickChange(nick: string, user: string, host: string, newNick: string): string {
  return fmt(`${nick}!${user}@${host}`, 'NICK', newNick);
}

export function ping(server: string, token: string): string {
  return `PING :${token}\r\n`;
}
