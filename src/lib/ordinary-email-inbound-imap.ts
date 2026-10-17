import { connect, type TLSSocket } from 'node:tls';
import { inboundDescriptorSchema, INBOUND_MIME_MAX_BYTES, OrdinaryInboundIdle, type InboundAdapter, type InboundPosition } from './ordinary-email-inbound-contract';
function denied(): never { throw new Error('ORDINARY_EMAIL_IMAP_DENIED'); }
const uint = (value: string, zero = false) => {
  if (!(zero ? /^(?:0|[1-9][0-9]{0,9})$/ : /^[1-9][0-9]{0,9}$/).test(value)) denied();
  const n = Number(value); if (n > 4_294_967_295) denied(); return n;
};
function internalDate(value: string) {
  const m = /^( [1-9]|0[1-9]|[12][0-9]|3[01])-([A-Z][a-z]{2})-([1-9][0-9]{3}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value);
  if (!m) denied();
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(m[2]);
  const year = Number(m[3]), day = Number(m[1]), hh = Number(m[4]), mm = Number(m[5]), ss = Number(m[6]);
  if (month < 0 || hh > 23 || mm > 59 || ss > 59 || Number(m[8]) > 23 || Number(m[9]) > 59) denied();
  const utc = Date.UTC(year,month,day,hh,mm,ss), date = new Date(utc);
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) denied();
  return new Date(utc - (m[7] === '+' ? 1 : -1) * (Number(m[8])*60 + Number(m[9]))*60_000).toISOString();
}

/** Bounded byte reader: no protocol/body/password logging and no reconnect. */
class Wire {
  private buffer: Buffer = Buffer.alloc(0);
  private total = 0;
  private lines = 0;
  private failure = false;
  private wake: (() => void) | undefined;
  private tag = 0;
  readonly secure: Promise<void>;
  private readonly stop: () => void;
  constructor(readonly socket: TLSSocket, readonly signal: AbortSignal, private readonly generation: string) {
    let secureDone!: () => void;
    this.secure = new Promise(resolve => { secureDone = resolve; });
    this.stop = () => { this.failure = true; secureDone(); this.wake?.(); socket.destroy(); };
    socket.once('secureConnect', () => {
      if (!socket.authorized || !['TLSv1.2','TLSv1.3'].includes(socket.getProtocol() ?? '')) this.stop();
      secureDone();
    });
    socket.on('data', (chunk: Buffer) => {
      this.total += chunk.length;
      if (this.total > INBOUND_MIME_MAX_BYTES + 128*1024 || this.buffer.length + chunk.length > INBOUND_MIME_MAX_BYTES + 8192) return this.stop();
      this.buffer = Buffer.concat([this.buffer,chunk]); this.wake?.();
    });
    socket.on('error', this.stop); socket.on('end', this.stop); socket.on('close', this.stop);
    signal.addEventListener('abort', this.stop, { once: true });
    if (signal.aborted) this.stop();
  }
  private assertLive() { if (this.failure || this.signal.aborted) denied(); }
  private async more() {
    this.assertLive();
    await new Promise<void>(resolve => { this.wake = resolve; });
    this.wake = undefined; this.assertLive();
  }
  async line() {
    for (;;) {
      this.assertLive();
      const index = this.buffer.indexOf('\r\n');
      if (index >= 0) {
        if (index > 8192 || ++this.lines > 512) denied();
        const value = this.buffer.subarray(0,index).toString('latin1'); this.buffer = this.buffer.subarray(index+2);
        if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) denied();
        return value;
      }
      if (this.buffer.length > 8192) denied();
      await this.more();
    }
  }
  async literal(size: number) {
    if (!Number.isSafeInteger(size) || size < 1 || size > INBOUND_MIME_MAX_BYTES) denied();
    while (this.buffer.length < size) await this.more();
    this.assertLive();
    const bytes = Buffer.from(this.buffer.subarray(0,size)); this.buffer = this.buffer.subarray(size); return bytes;
  }
  async command(command: string, consume?: (line: string) => Promise<void>) {
    this.assertLive(); const tag = 'A' + String(++this.tag).padStart(4,'0'), lines: string[] = [];
    this.socket.write(`${tag} ${command}\r\n`);
    for (;;) {
      const line = await this.line();
      if (/\[(?:CLOSED|READ-WRITE)\]/i.test(line) || /^\* (?:BYE|PREAUTH)\b/i.test(line)) denied();
      const generation = /\[UIDVALIDITY ([0-9]+)\]/i.exec(line);
      if (/\[UIDVALIDITY\b/i.test(line) && (!generation || generation[1] !== this.generation)) denied();
      if (line.startsWith(tag + ' ')) {
        if (!line.startsWith(tag + ' OK ')) denied();
        return { lines, tagged: line };
      }
      if (!line.startsWith('* ')) denied();
      if (/^\* [1-9][0-9]* FETCH /i.test(line)) {
        if (!consume) denied(); await consume(line);
      } else lines.push(line);
    }
  }
  close() { this.signal.removeEventListener('abort', this.stop); this.socket.destroy(); }
}

function metadata(line: string) {
  const match = /^\* ([1-9][0-9]*) FETCH \((.*)\)$/i.exec(line); if (!match) denied();
  let rest = match[2], uid: number | undefined, size: number | undefined, receivedAt: string | undefined;
  while (rest) {
    const part = /^(UID ([1-9][0-9]*)|RFC822\.SIZE ([0-9]+)|INTERNALDATE "([^"]+)")(?: |$)/i.exec(rest);
    if (!part) denied();
    if (part[2]) { if (uid !== undefined) denied(); uid = uint(part[2]); }
    else if (part[3]) { if (size !== undefined) denied(); size = uint(part[3]); }
    else { if (receivedAt !== undefined) denied(); receivedAt = internalDate(part[4]); }
    rest = rest.slice(part[0].length);
  }
  if (uid === undefined || size === undefined || !receivedAt || size > INBOUND_MIME_MAX_BYTES) denied();
  return { uid, size, receivedAt };
}

/** Explicit IMAP/password implementation only. No environment fallback, chosen
 * host, default generation, inferred initial cursor, worker or activation.
 * The caller supplies an already qualified descriptor/credential reference.
 * Cursor = last fully covered UID (decimal). Each page covers at most 25 UIDs,
 * including expunged gaps, bounded by the EXAMINE snapshot's UIDNEXT - 1. */
export function createOrdinaryImapInboundAdapter(readConfiguration: InboundAdapter['readConfiguration'],
  runtime: { connectTls?: typeof connect } = {}): InboundAdapter {
  return {
    readConfiguration,
    async readAuthenticated(configuration, position: InboundPosition, outerSignal) {
      const descriptor = inboundDescriptorSchema.parse(configuration.descriptor);
      if (descriptor.protocol !== 'IMAP_UID' || descriptor.folder !== 'INBOX'
        || !Number.isSafeInteger(position.version) || position.version < 0 || position.cursor === null
        || !/^[\x20-\x7e]{1,4096}$/.test(configuration.credential)) denied();
      uint(descriptor.generation); const cursor = uint(position.cursor,true);
      if (outerSignal.aborted) denied();
      const signal = AbortSignal.any([outerSignal,AbortSignal.timeout(15_000)]);
      const socket = (runtime.connectTls ?? connect)({ host: descriptor.host, port: descriptor.port,
        servername: descriptor.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      const wire = new Wire(socket,signal,descriptor.generation);
      try {
        await wire.secure;
        if (!/^\* OK /.test(await wire.line())) denied();
        const quoted = configuration.credential.replace(/["\\]/g,'\\$&');
        await wire.command(`LOGIN "comunicazioni@finanzaagevolaimpresa.it" "${quoted}"`);
        const selected = await wire.command('EXAMINE "INBOX"');
        if (!/^A[0-9]+ OK \[READ-ONLY\]/i.test(selected.tagged)) denied();
        const validity = selected.lines.filter(line => /^\* OK \[UIDVALIDITY [1-9][0-9]*\]/i.test(line));
        const next = selected.lines.filter(line => /^\* OK \[UIDNEXT [1-9][0-9]*\]/i.test(line));
        if (validity.length !== 1 || next.length !== 1) denied();
        const maximum = uint(/\[UIDNEXT ([0-9]+)\]/i.exec(next[0])![1]) - 1;
        if (maximum < cursor) denied();
        if (maximum === cursor) throw new OrdinaryInboundIdle();
        const end = Math.min(cursor + 25,maximum), entries: ReturnType<typeof metadata>[] = [];
        await wire.command(`UID FETCH ${cursor+1}:${end} (UID RFC822.SIZE INTERNALDATE)`,async line => {
          const item = metadata(line);
          if (item.uid <= cursor || item.uid > end || entries.some(row => row.uid === item.uid) || entries.length === 25) denied();
          entries.push(item);
          if (entries.reduce((sum,row) => sum + row.size,0) > INBOUND_MIME_MAX_BYTES) denied();
        });
        const items = [];
        for (const item of entries.sort((a,b) => a.uid-b.uid)) {
          let raw: Buffer | undefined;
          await wire.command(`UID FETCH ${item.uid} (UID BODY.PEEK[])`,async line => {
            if (raw) denied();
            const frame = /^\* [1-9][0-9]* FETCH \((?:UID ([1-9][0-9]*) )?BODY\[\] \{([1-9][0-9]*)\}$/i.exec(line);
            if (!frame || uint(frame[2]) !== item.size || (frame[1] && uint(frame[1]) !== item.uid)) denied();
            raw = await wire.literal(item.size);
            const tail = await wire.line();
            if (frame[1] ? tail !== ')' : tail !== ` UID ${item.uid})`) denied();
          });
          if (!raw || raw.length !== item.size) denied();
          items.push({providerId:String(item.uid),raw,expectedBytes:item.size,receivedAt:item.receivedAt});
        }
        await wire.command('NOOP');
        return { generation: descriptor.generation,fromCursor:position.cursor,nextCursor:String(end),items };
      } catch (error) {
        if (error instanceof OrdinaryInboundIdle) throw error;
        denied();
      } finally { wire.close(); }
    },
  };
}
