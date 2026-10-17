import { EventEmitter } from 'node:events';

export const imapRaw = Buffer.from('From: sender@invalid.test\r\nSubject: Synthetic receive\r\n\r\nPRIVATE_SYNTHETIC_RECEIVE');
export type ImapPeerOptions = {
  authorized?: boolean; protocol?: string; next?: number; validity?: string; afterUid?: boolean;
  uids?: number[]; size?: number; date?: string; readOnly?: boolean; hangOn?: string;
  transform?: (response: Buffer, command: string) => Buffer;
};
/** Synthetic-only peer shared by socket-double and real loopback TLS tests. */
export function imapReply(command: string, options: ImapPeerOptions = {}): Buffer {
  const tag = command.split(' ')[0], ok = `${tag} OK complete\r\n`;
  let reply: Buffer;
  if (command.includes(' LOGIN ')) reply = Buffer.from(ok);
  else if (command.includes(' EXAMINE ')) reply = Buffer.from([
    '* 2 EXISTS', `* OK [UIDVALIDITY ${options.validity ?? '9001'}] generation`,
    `* OK [UIDNEXT ${options.next ?? 103}] next`,
    `${tag} OK [${options.readOnly === false ? 'READ-WRITE' : 'READ-ONLY'}] selected`, ''].join('\r\n'));
  else if (command.includes(' RFC822.SIZE ')) reply = Buffer.from((options.uids ?? [101,102]).map((uid,i) =>
    `* ${i+1} FETCH (INTERNALDATE "${options.date ?? '17-Oct-2026 12:30:04 +0200'}" RFC822.SIZE ${options.size ?? imapRaw.length} UID ${uid})\r\n`).join('')+ok);
  else if (command.includes(' BODY.PEEK[]')) {
    const uid = /UID FETCH ([0-9]+)/.exec(command)![1];
    reply = Buffer.concat([Buffer.from(`* 1 FETCH (${options.afterUid ? '' : `UID ${uid} `}BODY[] {${imapRaw.length}}\r\n`),
      imapRaw, Buffer.from(`${options.afterUid ? ` UID ${uid}` : ''})\r\n${ok}`)]);
  } else if (command.includes(' NOOP')) reply = Buffer.from(ok);
  else throw new Error('SYNTHETIC_UNEXPECTED_COMMAND');
  return options.transform?.(reply,command) ?? reply;
}
export class SyntheticImapSocket extends EventEmitter {
  authorized: boolean; destroyed = false; writes: string[] = [];
  constructor(readonly options: ImapPeerOptions = {}) { super(); this.authorized = options.authorized ?? true; }
  getProtocol() { return this.options.protocol ?? 'TLSv1.3'; }
  reply(bytes: Buffer) {
    queueMicrotask(() => { for (let i=0; i<bytes.length && !this.destroyed; i+=7) this.emit('data',bytes.subarray(i,i+7)); });
  }
  write(command: string) {
    this.writes.push(command);
    if (!this.options.hangOn || !command.includes(this.options.hangOn)) this.reply(imapReply(command,this.options));
    return true;
  }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } return this; }
}
