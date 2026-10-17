import assert from 'node:assert/strict';
import test from 'node:test';
import type { connect } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { createOrdinaryImapInboundAdapter } from '../src/lib/ordinary-email-inbound-imap';
import { consumeInboundReceipt, inboundQualificationReference, OrdinaryInboundIdle,
  type InboundBinding, type InboundDescriptor } from '../src/lib/ordinary-email-inbound-contract';
import { createOrdinaryMimeInboundSource } from '../src/lib/ordinary-email-inbound-mime';
import { imapRaw, SyntheticImapSocket, type ImapPeerOptions } from './helpers/ordinary-imap-peer';

const descriptor: InboundDescriptor = { protocol:'IMAP_UID',host:'incoming.invalid.test',port:993,security:'TLS',
  minVersion:'TLSv1.2',rejectUnauthorized:true,folder:'INBOX',generation:'9001',authenticationReference:'SYNTHETIC_ONLY' };
const configuration = { descriptor, credential:'synthetic-quote"and\\slash' };
const position = { version:4,cursor:'100' };
function fixture(options: ImapPeerOptions = {}) {
  const socket = new SyntheticImapSocket(options), connections: unknown[] = [];
  const connectTls = ((input: unknown) => { connections.push(input);
    queueMicrotask(() => { socket.emit('secureConnect'); socket.reply(Buffer.from('* OK synthetic\r\n')); });
    return socket;
  }) as unknown as typeof connect;
  const adapter = createOrdinaryImapInboundAdapter(() => configuration,{connectTls});
  return { socket,connections,adapter,read: (signal = new AbortController().signal) => adapter.readAuthenticated(configuration,position,signal) };
}

test('IMAP uses verified TLS, EXAMINE and BODY.PEEK; literal bytes and internal dates survive fragmentation', async () => {
  for (const afterUid of [false,true]) {
    const f = fixture({afterUid}), result = await f.read();
    assert.deepEqual(result,{generation:'9001',fromCursor:'100',nextCursor:'102',items:[101,102].map(uid => ({
      providerId:String(uid),raw:imapRaw,expectedBytes:imapRaw.length,receivedAt:'2026-10-17T10:30:04.000Z'}))});
    assert.deepEqual(f.connections,[{host:descriptor.host,port:993,servername:descriptor.host,rejectUnauthorized:true,minVersion:'TLSv1.2'}]);
    assert.deepEqual(f.socket.writes,[
      'A0001 LOGIN "comunicazioni@finanzaagevolaimpresa.it" "synthetic-quote\\"and\\\\slash"\r\n',
      'A0002 EXAMINE "INBOX"\r\n','A0003 UID FETCH 101:102 (UID RFC822.SIZE INTERNALDATE)\r\n',
      'A0004 UID FETCH 101 (UID BODY.PEEK[])\r\n','A0005 UID FETCH 102 (UID BODY.PEEK[])\r\n','A0006 NOOP\r\n']);
    assert.equal(f.socket.destroyed,true);
  }
});

test('IMAP covers at most 25 UID positions, including expunged gaps, without scanning the entire mailbox', async () => {
  const f = fixture({next:400_000,uids:[]});
  assert.deepEqual(await f.read(),{generation:'9001',fromCursor:'100',nextCursor:'125',items:[]});
  assert.ok(f.socket.writes.includes('A0003 UID FETCH 101:125 (UID RFC822.SIZE INTERNALDATE)\r\n'));
});

test('no initial cursor or unsupported protocol, generation, folder or password can open a socket', async () => {
  for (const [config,pos] of [
    [configuration,{version:0,cursor:null}], [configuration,{version:-1,cursor:'100'}],
    [configuration,{version:0,cursor:'0100'}], [configuration,{version:0,cursor:'4294967296'}],
    [{...configuration,descriptor:{...descriptor,protocol:'PROVIDER_CURSOR'}},position],
    [{...configuration,descriptor:{...descriptor,folder:'Archive'}},position],
    [{...configuration,descriptor:{...descriptor,generation:'guessed'}},position],
    [{...configuration,credential:'bad\r\npassword'},position],
  ] as const) {
    const f=fixture(); await assert.rejects(f.adapter.readAuthenticated(config,pos,new AbortController().signal));
    assert.equal(f.connections.length,0);
  }
});

for (const [name,options] of Object.entries<ImapPeerOptions>({
  'untrusted certificate':{authorized:false}, 'obsolete TLS':{protocol:'TLSv1'},
  'read-write selection':{readOnly:false}, 'changed UIDVALIDITY':{validity:'9002'},
  'cursor beyond current mailbox':{next:100}, 'duplicate UID':{uids:[101,101]},
  'UID outside requested range':{uids:[103]}, 'oversized raw message':{size:1024*1024+1},
  'oversized whole page':{size:600_000}, 'invalid internal delivery date':{date:'31-Feb-2026 00:00:00 +0000'},
  'wrong declared literal size':{size:imapRaw.length-1},
  'authentication refusal':{transform:(bytes,cmd)=>cmd.includes(' LOGIN ')?Buffer.from('A0001 NO denied\r\n'):bytes},
  'generation changed during read':{transform:(bytes,cmd)=>cmd.includes(' NOOP')?Buffer.concat([Buffer.from('* OK [UIDVALIDITY 9002] changed\r\n'),bytes]):bytes},
  'malformed generation during read':{transform:(bytes,cmd)=>cmd.includes(' NOOP')?Buffer.concat([Buffer.from('* OK [UIDVALIDITY unknown] changed\r\n'),bytes]):bytes},
  'body UID differs from metadata':{transform:(bytes,cmd)=>cmd.includes(' BODY.PEEK[]')?Buffer.from(bytes.toString().replace('UID 101 BODY','UID 104 BODY')):bytes},
  'unexpected literal trailer':{transform:(bytes,cmd)=>cmd.includes(' BODY.PEEK[]')?Buffer.from(bytes.toString().replace(')\r\n', ' FLAGS (\\Seen))\r\n')):bytes},
  'overlong protocol line':{transform:(bytes,cmd)=>cmd.includes(' NOOP')?Buffer.from('* OK '+ 'x'.repeat(8200)+'\r\n'):bytes},
})) test(`IMAP denies ${name} without exposing content or credentials`, async () => {
  const f=fixture(options); await assert.rejects(f.read(),/^Error: ORDINARY_EMAIL_IMAP_DENIED$/);
  assert.equal(f.socket.destroyed,true);
  if (options.authorized===false || options.protocol==='TLSv1') assert.equal(f.socket.writes.length,0);
});

test('IMAP abort and disconnect destroy the only connection with no reconnect', async () => {
  for (const disconnect of [false,true]) {
    const f=fixture({hangOn:'EXAMINE'}), controller=new AbortController(), pending=f.read(controller.signal);
    await new Promise(resolve=>setImmediate(resolve));
    if(disconnect) f.socket.destroy(); else controller.abort();
    await assert.rejects(pending,/ORDINARY_EMAIL_IMAP_DENIED/);
    assert.equal(f.connections.length,1); assert.equal(f.socket.destroyed,true);
  }
});

test('authenticated idle creates no receipt; full source path binds MIME, generation, credential and covered position', async () => {
  const key={version:1,secret:'synthetic-imap-source-key-not-real-00000000000000'};
  const binding:InboundBinding={id:randomUUID(),mailboxId:randomUUID(),mailboxRevision:1,revision:1,
    descriptor,qualificationReference:'',validUntil:new Date(Date.now()+60_000)};
  binding.qualificationReference=inboundQualificationReference(binding,key,configuration.credential);
  const f=fixture(),source=createOrdinaryMimeInboundSource(key,f.adapter);
  const batch=consumeInboundReceipt(await source.read(binding,position),binding,position,new Date()).batch;
  assert.equal(batch.items[0].message.mime!.rawBase64,imapRaw.toString('base64'));
  const idle=fixture({next:101}),idleSource=createOrdinaryMimeInboundSource(key,idle.adapter);
  await assert.rejects(idleSource.read(binding,position),OrdinaryInboundIdle);
  assert.equal(idle.socket.writes.length,2); assert.equal(idle.socket.destroyed,true);
});
