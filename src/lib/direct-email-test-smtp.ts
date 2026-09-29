import { connect, type TLSSocket } from 'node:tls';
import { DIRECT_TEST_FROM, directTestMessage, type DirectTestConfig, type DirectTestOutcome, type DirectTestTransportControl } from './direct-email-test';

// Deliberately narrow diagnostic transport: one TLS/465 connection, one recipient,
// fixed text, no attachments, STARTTLS downgrade, pool, reconnect or retry.
class Replies {
  private buffer = '';
  private lines = 0;
  private multiline: number | null = null;
  private queue: number[] = [];
  private waiting: { resolve: (code: number) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;
  constructor(socket: TLSSocket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.accept(chunk));
    socket.on('error', () => this.fail());
    socket.on('close', () => this.fail());
  }
  private fail() {
    this.failure = new Error('SMTP_UNAVAILABLE');
    this.waiting?.reject(this.failure); this.waiting = null;
  }
  private accept(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 16384) return this.fail();
    let end: number;
    while ((end = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2);
      const match = /^(\d{3})([- ])[^\r\n]*$/.exec(line);
      if (!match || ++this.lines > 100 || line.length > 2048) return this.fail();
      const code = Number(match[1]);
      if (this.multiline !== null && code !== this.multiline) return this.fail();
      if (match[2] === '-') this.multiline = code;
      else {
        this.multiline = null; this.lines = 0;
        if (this.waiting) { this.waiting.resolve(code); this.waiting = null; }
        else if (this.queue.length < 2) this.queue.push(code);
        else return this.fail();
      }
    }
  }
  read() {
    if (this.failure) return Promise.reject(this.failure);
    const code = this.queue.shift();
    if (code !== undefined) return Promise.resolve(code);
    if (this.waiting) return Promise.reject(new Error('SMTP_PROTOCOL'));
    return new Promise<number>((resolve, reject) => { this.waiting = { resolve, reject }; });
  }
}
export function directTestMime(config: DirectTestConfig, attemptId: string) {
  if (!/^direct_test_[a-f0-9]{64}$/.test(attemptId)) throw new Error('INVALID_ATTEMPT');
  const message = directTestMessage(config);
  return [
    `From: ${message.from}`, `Reply-To: ${message.replyTo}`, `To: ${message.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`,
    `Message-ID: <${attemptId}@crm.finanzaagevolaimpresa.it>`, `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(message.body).toString('base64').match(/.{1,76}/g)!.join('\r\n'), '', '.', '',
  ].join('\r\n');
}
export async function sendDirectTestSmtp(config: DirectTestConfig, attemptId: string, control: DirectTestTransportControl, connectTls: typeof connect = connect): Promise<DirectTestOutcome> {
  const remaining = Math.min(15_000, control.deadline - performance.now());
  if (control.signal.aborted || !Number.isFinite(remaining) || remaining <= 0) return 'NOT_SENT';
  const socket = connectTls({ host: config.host, port: 465, servername: config.host,
    rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  const replies = new Replies(socket);
  const abort = () => socket.destroy(new Error('SMTP_ABORTED'));
  const timeout = setTimeout(abort, remaining);
  control.signal.addEventListener('abort', abort, { once: true });
  let contentSubmitted = false;
  function assertLive() {
    if (control.signal.aborted || performance.now() >= control.deadline || socket.destroyed) throw new Error('SMTP_EXPIRED');
  }
  async function command(text: string, expected: number[]) {
    assertLive();
    socket.write(`${text}\r\n`);
    const code = await replies.read();
    if (!expected.includes(code)) throw new Error('SMTP_REJECTED');
  }
  try {
    assertLive();
    await new Promise<void>((resolve, reject) => {
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('SMTP_UNAVAILABLE')); };
      const cleanup = () => { socket.off('secureConnect', ready); socket.off('error', failed); socket.off('close', failed); };
      socket.once('secureConnect', ready); socket.once('error', failed); socket.once('close', failed);
    });
    assertLive();
    if (!socket.authorized || await replies.read() !== 220) return 'NOT_SENT';
    await command('EHLO crm.finanzaagevolaimpresa.it', [250]);
    await command(`AUTH PLAIN ${Buffer.from(`\0${DIRECT_TEST_FROM}\0${config.password}`).toString('base64')}`, [235]);
    await command(`MAIL FROM:<${DIRECT_TEST_FROM}>`, [250]);
    await command(`RCPT TO:<${config.recipient}>`, [250, 251]);
    await command('DATA', [354]);
    assertLive();
    contentSubmitted = true;
    socket.write(directTestMime(config, attemptId));
    const outcome = await replies.read();
    if (outcome === 250) return 'ACCEPTED';
    if (outcome >= 400 && outcome < 600) return 'NOT_SENT';
    return 'UNCERTAIN';
  } catch {
    return contentSubmitted ? 'UNCERTAIN' : 'NOT_SENT';
  } finally { clearTimeout(timeout); control.signal.removeEventListener('abort', abort); socket.destroy(); }
}
