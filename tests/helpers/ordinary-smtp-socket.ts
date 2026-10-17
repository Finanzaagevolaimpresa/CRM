import { EventEmitter } from 'node:events';

/** Synthetic protocol peer; never opens a network connection. */
export type WireOptions = {
  authorized?: boolean; protocol?: string; greeting?: string; ehlo?: string; auth?: string; mail?: string;
  refuseRecipient?: number; final?: string | null; contentWriteThrows?: boolean; closeAfterFinal?: boolean;
  onWrite?: (text: string) => void;
  beforeDataReply?: () => Promise<void>;
};
export class SyntheticSocket extends EventEmitter {
  authorized: boolean; destroyed = false; writes: string[] = []; private content = false; private recipients = 0;
  constructor(private options: WireOptions) { super(); this.authorized = options.authorized ?? true; }
  setEncoding() { return this; }
  getProtocol() { return this.options.protocol ?? 'TLSv1.3'; }
  reply(text: string) {
    queueMicrotask(() => {
      if (this.destroyed) return;
      for (let start = 0; start < text.length && !this.destroyed; start += 3) this.emit('data', text.slice(start, start + 3));
    });
  }
  write(text: string) {
    if (this.destroyed) throw new Error('SYNTHETIC_CLOSED');
    this.writes.push(text); this.options.onWrite?.(text);
    if (text === 'QUIT\r\n') { this.reply('221 closing\r\n'); return true; }
    if (this.content) {
      if (this.options.contentWriteThrows) throw new Error('SYNTHETIC_PARTIAL_WRITE');
      if (this.options.final === null) { queueMicrotask(() => this.destroy()); return true; }
      this.reply(this.options.final ?? '250 accepted\r\n');
      if (this.options.closeAfterFinal) queueMicrotask(() => this.destroy());
    } else if (text.startsWith('EHLO ')) this.reply(this.options.ehlo ?? '250-synthetic.invalid\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 30000000\r\n');
    else if (text.startsWith('AUTH PLAIN ')) this.reply(this.options.auth ?? '235 authenticated\r\n');
    else if (text.startsWith('MAIL FROM:')) this.reply(this.options.mail ?? '250 sender accepted\r\n');
    else if (text.startsWith('RCPT TO:')) this.reply(++this.recipients === this.options.refuseRecipient ? '550 refused\r\n' : '250 recipient accepted\r\n');
    else if (text === 'DATA\r\n') {
      this.content = true;
      if (this.options.beforeDataReply) void this.options.beforeDataReply().then(() => this.reply('354 continue\r\n')).catch(() => this.destroy());
      else this.reply('354 continue\r\n');
    } else throw new Error('SYNTHETIC_UNEXPECTED_COMMAND');
    return true;
  }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } return this; }
}
