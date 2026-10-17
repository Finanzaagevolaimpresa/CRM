import type { connect, TLSSocket } from 'node:tls';
import { z } from 'zod';
import type { ApprovedMessageSnapshot } from './approved-communication-contract';
import { canonicalSha256 } from './canonical-json';
import { prepareOrdinaryEmail, type OrdinaryChannel } from './ordinary-email-candidate';

/** Isolated transport candidate. No default connector, route, DB implementation,
 * retry, worker or activation. Only a trusted server service may supply these
 * dependencies after implementing the durable, audited personal-decision gate.
 * Neither a signed preview nor an M4 manual approval is a transport permit. */
type Material = { snapshot: ApprovedMessageSnapshot; channel: OrdinaryChannel; materials: Map<string, Buffer>; preparedAt: Date };
export type OrdinaryAttemptRequest = Readonly<{
  attemptId: string; intentHash: string; mimeHash: string; envelopeHash: string; channel: OrdinaryChannel;
}>;
const leaseSchema = z.object({ attemptId: z.string().uuid(), leaseId: z.string().uuid(), committed: z.literal(true), expiresAt: z.string().datetime() }).strict();
export type OrdinaryAttemptLease = Readonly<z.infer<typeof leaseSchema>>;
export type OrdinarySmtpDependencies = {
  /** Atomically consume an already committed unique reservation, with audit.
   * Verify the canonical personal decision, exact request, current context and
   * absence of manual/ordinary concurrent attempts. Null/unknown commit denies
   * a connection. Repeated request IDs or leases must never grant another use. */
  takeCommittedAttempt(request: OrdinaryAttemptRequest): Promise<OrdinaryAttemptLease | null>;
  /** Current authoritative actor/session, channel, context and expiry. */
  assertCurrent(lease: OrdinaryAttemptLease): Promise<void>;
  /** Hold authoritative locks from before DATA through its bounded response.
   * The supplied check uses the same locked transaction and a fresh DB clock.
   * No retry of the callback, including after an uncertain commit response. */
  withCurrentAuthorization<T>(lease: OrdinaryAttemptLease, operation: (check: () => Promise<void>) => Promise<T>): Promise<T>;
  /** Resolve only the qualified configuration referenced by the committed lease.
   * A host is never inferred from the provider name or accepted from a form. */
  readQualifiedTransport(lease: OrdinaryAttemptLease): Promise<{ host: string; password: string }>;
  connectTls: typeof connect;
};
type Phase = 'PREPARATION' | 'CLAIM' | 'CONNECT' | 'GREETING' | 'EHLO' | 'AUTH' | 'MAIL' | 'RCPT' | 'DATA' | 'CONTENT';
export type OrdinarySmtpResult = { outcome: 'ACCEPTED' | 'NOT_SENT' | 'UNCERTAIN'; phase: Phase; replyCode?: number };
type Reply = { code: number; lines: string[] };

class Replies {
  private buffer = '';
  private lines: string[] = [];
  private multiline: number | null = null;
  private greeting: Reply | null = null;
  private greetingRead = false;
  private failure: Error | null = null;
  private waiting: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | null = null;
  constructor(socket: TLSSocket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.accept(chunk));
    socket.on('error', () => this.fail());
    socket.on('close', () => this.fail());
  }
  private fail() {
    this.failure = new Error('ORDINARY_SMTP_UNAVAILABLE');
    this.waiting?.reject(this.failure); this.waiting = null;
  }
  private accept(chunk: string) {
    if (this.failure) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 16384) return this.fail();
    let end: number;
    while ((end = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2);
      const match = /^([2-5]\d{2})(?:([- ])([^\r\n]*))?$/.exec(line);
      if (!match || Buffer.byteLength(line) > 510 || this.lines.length >= 64) return this.fail();
      const code = Number(match[1]);
      if (this.multiline !== null && this.multiline !== code) return this.fail();
      this.lines.push(match[3] ?? '');
      if (match[2] === '-') this.multiline = code;
      else {
        const reply = { code, lines: this.lines }; this.lines = []; this.multiline = null;
        if (this.waiting) { this.waiting.resolve(reply); this.waiting = null; }
        else if (!this.greetingRead && !this.greeting) this.greeting = reply;
        else return this.fail(); // No pipelining or unsolicited command replies.
      }
    }
  }
  check() { if (this.failure) throw this.failure; }
  read() {
    this.check();
    this.greetingRead = true;
    if (this.greeting) { const reply = this.greeting; this.greeting = null; return Promise.resolve(reply); }
    if (this.waiting) throw new Error('ORDINARY_SMTP_PROTOCOL');
    return new Promise<Reply>((resolve, reject) => { this.waiting = { resolve, reject }; });
  }
}

export async function transmitOrdinaryEmailCandidate(
  material: Material, attemptId: string, control: { deadline: number; signal: AbortSignal }, dependencies: OrdinarySmtpDependencies,
): Promise<OrdinarySmtpResult> {
  let phase: Phase = 'PREPARATION', replyCode: number | undefined, contentSubmitted = false;
  let socket: TLSSocket | undefined, lease: OrdinaryAttemptLease | undefined, replies: Replies | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = new AbortController();
  const abort = () => { stop.abort(); socket?.destroy(); };
  const deadline = Math.min(control.deadline, performance.now() + 15_000);
  const expired = new Promise<never>((_, reject) => stop.signal.addEventListener('abort', () => reject(new Error('ORDINARY_SMTP_EXPIRED')), { once: true }));
  void expired.catch(() => {});
  const bounded = <T>(operation: Promise<T>) => Promise.race([operation, expired]);
  function live() {
    if (!Number.isFinite(deadline) || performance.now() >= deadline || control.signal.aborted || stop.signal.aborted
      || socket?.destroyed || (lease && Date.parse(lease.expiresAt) <= Date.now())) throw new Error('ORDINARY_SMTP_EXPIRED');
    replies?.check();
  }
  async function current() { live(); await bounded(dependencies.assertCurrent(lease!)); live(); }
  async function command(text: string, expected: number[]) {
    live(); replyCode = undefined;
    const response = bounded(replies!.read()); void response.catch(() => {});
    socket!.write(text + '\r\n');
    const reply = await response; replyCode = reply.code;
    if (!expected.includes(reply.code)) throw new Error('ORDINARY_SMTP_REJECTED');
    return reply;
  }
  try {
    live(); z.string().uuid().parse(attemptId);
    // Rebuild from the versioned material before any await; callers never get
    // a reference to the private MIME/envelope used by this invocation.
    const prepared = prepareOrdinaryEmail(material.snapshot, material.channel, material.materials, material.preparedAt);
    const mime = prepared.mime.toString('ascii');
    const request: OrdinaryAttemptRequest = Object.freeze({ attemptId, intentHash: prepared.intentHash, mimeHash: prepared.mimeHash,
      envelopeHash: canonicalSha256(prepared.envelope), channel: Object.freeze(prepared.intent.channel) });
    timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
    control.signal.addEventListener('abort', abort, { once: true });
    live(); phase = 'CLAIM';
    const claimed = await bounded(dependencies.takeCommittedAttempt(request));
    lease = Object.freeze(leaseSchema.parse(claimed));
    if (lease.attemptId !== attemptId) throw new Error('ORDINARY_SMTP_ATTEMPT_MISMATCH');
    await current();
    const transport = z.object({ host: z.string().min(1).max(253)
      .regex(/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/),
    password: z.string().min(1).max(4096).refine(value => !value.includes('\0')) }).strict().parse(await bounded(dependencies.readQualifiedTransport(lease)));
    await current(); phase = 'CONNECT';
    socket = dependencies.connectTls({ host: transport.host, port: 465, servername: transport.host,
      rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    replies = new Replies(socket);
    await bounded(new Promise<void>((resolve, reject) => {
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('ORDINARY_SMTP_UNAVAILABLE')); };
      const cleanup = () => { socket!.off('secureConnect', ready); socket!.off('error', failed); socket!.off('close', failed); };
      socket!.once('secureConnect', ready); socket!.once('error', failed); socket!.once('close', failed);
    }));
    live();
    if (!socket.authorized || !['TLSv1.2', 'TLSv1.3'].includes(socket.getProtocol() ?? '')) throw new Error('ORDINARY_SMTP_TLS_REQUIRED');
    phase = 'GREETING'; const greeting = await bounded(replies.read()); replyCode = greeting.code;
    if (greeting.code !== 220) throw new Error('ORDINARY_SMTP_GREETING');
    phase = 'EHLO'; const capabilities = await command('EHLO crm.finanzaagevolaimpresa.it', [250]);
    if (!capabilities.lines.some(line => /^AUTH(?: |=)/i.test(line) && line.slice(5).split(/ +/).some(value => value.toUpperCase() === 'PLAIN')))
      throw new Error('ORDINARY_SMTP_AUTH_UNSUPPORTED');
    phase = 'AUTH'; await command(`AUTH PLAIN ${Buffer.from(`\0${prepared.envelope.from}\0${transport.password}`).toString('base64')}`, [235]);
    phase = 'MAIL'; await command(`MAIL FROM:<${prepared.envelope.from}>`, [250]);
    phase = 'RCPT';
    for (const recipient of prepared.envelope.recipients) await command(`RCPT TO:<${recipient}>`, [250, 251]);
    // Serialize current authorization with DATA. Ordinary preflight reads do
    // not close a concurrent revocation window. The private server guard owns
    // the transaction; only this callback can set an observed SMTP outcome.
    let entered = false, result: OrdinarySmtpResult | undefined;
    await bounded(dependencies.withCurrentAuthorization(lease, async check => {
      if (entered) throw new Error('ORDINARY_SMTP_GUARD_REPLAY');
      entered = true;
      live(); await bounded(check()); live();
      phase = 'DATA'; await command('DATA', [354]);
      await bounded(check()); live(); phase = 'CONTENT'; replyCode = undefined;
      const response = bounded(replies!.read()); void response.catch(() => {});
      contentSubmitted = true; // A throwing write may be partial.
      socket!.write(mime.replace(/(^|\r\n)\./g, '$1..') + '.\r\n');
      const reply = await response; replyCode = reply.code;
      result = { outcome: reply.code === 250 ? 'ACCEPTED' : reply.code >= 400 && reply.code < 600 ? 'NOT_SENT' : 'UNCERTAIN', phase, replyCode };
      return result;
    }));
    if (!result) throw new Error('ORDINARY_SMTP_GUARD_REQUIRED');
    // Graceful closure cannot change an already definitive DATA result. An
    // unknown protocol state is closed without sending further message bytes.
    if (result.outcome !== 'UNCERTAIN') { try { await command('QUIT', [221]); } catch {} }
    return result;
  } catch {
    return { outcome: contentSubmitted ? 'UNCERTAIN' : 'NOT_SENT', phase, ...(replyCode === undefined ? {} : { replyCode }) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    control.signal.removeEventListener('abort', abort);
    socket?.destroy();
  }
}
