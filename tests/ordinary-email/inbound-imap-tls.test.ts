import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { connect, createServer, type TLSSocket } from 'node:tls';
import { createOrdinaryImapInboundAdapter } from '../../src/lib/ordinary-email-inbound-imap';
import type { InboundDescriptor } from '../../src/lib/ordinary-email-inbound-contract';
import { imapRaw, imapReply } from '../helpers/ordinary-imap-peer';

const enabled = process.env.ORDINARY_IMAP_TLS_TEST === 'SYNTHETIC_LOOPBACK_ONLY';
for (const mode of ['trusted','untrusted','wrong-name'] as const) test(`synthetic IMAP TLS: ${mode}`,{skip:!enabled,timeout:10_000},async()=>{
  const cert=readFileSync(process.env.ORDINARY_IMAP_TEST_CERT!),key=readFileSync(process.env.ORDINARY_IMAP_TEST_KEY!);
  const sockets=new Set<TLSSocket>(),commands:string[]=[];
  const server=createServer({cert,key,minVersion:'TLSv1.2'},socket=>{
    sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>socket.destroy());
    socket.write('* OK synthetic loopback\r\n');
    let buffer='';
    socket.on('data',chunk=>{
      buffer+=chunk.toString();
      while(buffer.includes('\r\n')) {
        const end=buffer.indexOf('\r\n'),command=buffer.slice(0,end+2); buffer=buffer.slice(end+2);
        commands.push(command); const response=imapReply(command);
        for(let start=0;start<response.length;start+=13) socket.write(response.subarray(start,start+13));
      }
    });
  });
  server.on('tlsClientError',()=>{});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address(); assert.ok(address && typeof address!=='string');
    const descriptor:InboundDescriptor={protocol:'IMAP_UID',host:mode==='wrong-name'?'wrong.invalid':'localhost',
      port:address.port,security:'TLS',minVersion:'TLSv1.2',rejectUnauthorized:true,folder:'INBOX',generation:'9001',authenticationReference:'SYNTHETIC_ONLY'};
    const config={descriptor,credential:'synthetic-only'};
    const connectTls=((input: object)=>connect({...input,host:'127.0.0.1',...(mode==='untrusted'?{}:{ca:cert})})) as typeof connect;
    const adapter=createOrdinaryImapInboundAdapter(()=>config,{connectTls});
    const pending=adapter.readAuthenticated(config,{version:0,cursor:'100'},new AbortController().signal);
    if(mode==='trusted') {
      const result=await pending;
      assert.deepEqual(result,{generation:'9001',fromCursor:'100',nextCursor:'102',items:[101,102].map(uid=>({
        providerId:String(uid),raw:imapRaw,expectedBytes:imapRaw.length,receivedAt:'2026-10-17T10:30:04.000Z'}))});
      assert.equal(commands.length,6); assert.ok(commands.some(command=>command.includes(' EXAMINE "INBOX"')));
      assert.equal(commands.filter(command=>command.includes('BODY.PEEK[]')).length,2);
    } else {
      await assert.rejects(pending,/ORDINARY_EMAIL_IMAP_DENIED/); assert.equal(commands.length,0);
    }
  } finally { for(const socket of sockets) socket.destroy(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
