import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { connect } from 'node:tls';
import { createOrdinaryRegisterInboundSource } from '../src/lib/ordinary-email-inbound-runtime';
import { inboundQualificationReference, OrdinaryInboundIdle, type InboundBinding, type InboundDescriptor } from '../src/lib/ordinary-email-inbound-contract';
import { SyntheticImapSocket } from './helpers/ordinary-imap-peer';

const key = { version: 1, secret: 'SYNTHETIC_REGISTER_KEY_ONLY_0000000000000000' };
const descriptor: InboundDescriptor = { protocol: 'IMAP_UID', host: 'pop.securemail.pro', port: 993,
  security: 'TLS', minVersion: 'TLSv1.2', rejectUnauthorized: true, folder: 'INBOX', generation: '9001',
  authenticationReference: 'DIRECT_EMAIL_TEST_SMTP_PASSWORD' };
function fixture() {
  const environment: Record<string,string | undefined> = { DIRECT_EMAIL_TEST_MODE: 'enforced',
    DIRECT_EMAIL_TEST_REFERENCE: 'R49_EMAIL_DIRECT_20260930_01', DIRECT_EMAIL_TEST_SMTP_HOST: 'authsmtp.securemail.pro',
    DIRECT_EMAIL_TEST_SMTP_PASSWORD: 'SYNTHETIC_MAILBOX_PASSWORD_ONLY' };
  const binding: InboundBinding = { id: randomUUID(), mailboxId: randomUUID(), mailboxRevision: 2, revision: 1,
    descriptor, validUntil: new Date(Date.now()+60_000), qualificationReference: '' };
  binding.qualificationReference = inboundQualificationReference(binding,key,environment.DIRECT_EMAIL_TEST_SMTP_PASSWORD!);
  let connections = 0;
  const socket = new SyntheticImapSocket({next:101});
  const runtime = {readEnvironment:()=>environment,connectTls:((options: unknown)=> {
    connections++;
    assert.deepEqual(options,{host:'pop.securemail.pro',port:993,servername:'pop.securemail.pro',rejectUnauthorized:true,minVersion:'TLSv1.2'});
    queueMicrotask(()=>{socket.emit('secureConnect');socket.reply(Buffer.from('* OK synthetic peer\r\n'));});
    return socket;
  }) as unknown as typeof connect};
  return { environment,binding,runtime,socket,connections:()=>connections };
}

test('operational source uses the qualified existing mailbox credential and reads INBOX without fetching at idle',async()=>{
  const f=fixture(),source=createOrdinaryRegisterInboundSource(key,descriptor,f.runtime);
  await assert.rejects(source.read(f.binding,{version:0,cursor:'100'}),OrdinaryInboundIdle);
  assert.equal(f.connections(),1); assert.equal(f.socket.destroyed,true);
  assert.equal(f.socket.writes.length,2);
  assert.match(f.socket.writes[0],/^A0001 LOGIN "comunicazioni@finanzaagevolaimpresa.it" /);
  assert.equal(f.socket.writes[1],'A0002 EXAMINE "INBOX"\r\n');
});

test('operational source cannot redirect the existing secret using a stored descriptor',()=>{
  for(const changed of [{host:'outside.invalid.test'},{port:465},{folder:'Sent'},{authenticationReference:'OTHER_SECRET'},
    {generation:'4294967296'},{generation:'0'},{generation:'9001 injected'}]) {
    const f=fixture();
    assert.throws(()=>createOrdinaryRegisterInboundSource(key,{...descriptor,...changed},f.runtime),/ORDINARY_EMAIL_INBOUND_DENIED/);
    assert.equal(f.connections(),0);
  }
});

test('source configuration or password drift fails before any connection and reveals no credential',async()=>{
  for(const field of ['DIRECT_EMAIL_TEST_MODE','DIRECT_EMAIL_TEST_REFERENCE','DIRECT_EMAIL_TEST_SMTP_HOST','DIRECT_EMAIL_TEST_SMTP_PASSWORD']) {
    for(const value of [undefined,'SYNTHETIC_CHANGED_VALUE']) {
      const f=fixture(),source=createOrdinaryRegisterInboundSource(key,descriptor,f.runtime);
      f.environment[field]=value;
      await assert.rejects(source.read(f.binding,{version:0,cursor:'100'}),{message:'ORDINARY_EMAIL_INBOUND_DENIED'});
      assert.equal(f.connections(),0);
    }
  }
});
