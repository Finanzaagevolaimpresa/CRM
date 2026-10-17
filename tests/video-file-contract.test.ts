import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyVideoFile, resolveVideoRange, VideoFileError, videoMaxBytes } from '../src/lib/video-file-contract';

const mp4 = Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,49]);
const webm = Uint8Array.from([0x1a,0x45,0xdf,0xa3,0x87,0x42,0x82,0x84,119,101,98,109]);
const rejects = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof VideoFileError && e.code === code);

test('recognizable MP4/WebM with bounded size, independent of submitted MIME', () => {
  assert.equal(identifyVideoFile('Formazione.MP4',24,mp4),'video/mp4');
  assert.equal(identifyVideoFile('Operatività.webm',12,webm),'video/webm');
});
test('file names cannot select a storage path or active document format', () => {
  for (const name of ['../x.mp4','x/film.mp4','x\\film.mp4','x\0.mp4','x.mp4.html','x.html','a..mp4']) {
    rejects(() => identifyVideoFile(name,24,mp4),'VIDEO_FILE_INVALID');
  }
});
test('empty, excessive, fractional and inconsistent sizes are rejected', () => {
  for (const size of [0,-1,11,videoMaxBytes+1,Infinity,NaN,24.5,12]) rejects(() => identifyVideoFile('x.mp4',size,mp4),'VIDEO_FILE_INVALID');
});
test('extension and actual container must agree', () => {
  rejects(() => identifyVideoFile('x.webm',24,mp4),'VIDEO_FILE_INVALID');
  rejects(() => identifyVideoFile('x.mp4',12,webm),'VIDEO_FILE_INVALID');
  rejects(() => identifyVideoFile('x.mp4',24,new Uint8Array(24)),'VIDEO_FILE_INVALID');
});
test('MP4 rejects truncated and unbounded ftyp boxes and unsupported brands', () => {
  for (const boxSize of [0,8,23,28]) { const b=mp4.slice();b[3]=boxSize;rejects(() => identifyVideoFile('x.mp4',24,b),'VIDEO_FILE_INVALID'); }
  const b=mp4.slice();b[8]=0;rejects(() => identifyVideoFile('x.mp4',24,b),'VIDEO_FILE_INVALID');
});
test('WebM rejects unknown EBML sizes, truncated elements and another document type', () => {
  for (const mutate of [(b:Uint8Array)=>{b[4]=0xff;},(b:Uint8Array)=>{b[4]=0x88;},(b:Uint8Array)=>{b[7]=0x85;},(b:Uint8Array)=>{b[8]=0;}]) {
    const b=webm.slice();mutate(b);rejects(() => identifyVideoFile('x.webm',12,b),'VIDEO_FILE_INVALID');
  }
});
test('ordinary whole response has exact length and no partial-response header', () => {
  assert.deepEqual(resolveVideoRange(null,100),{status:200,start:0,end:99,length:100,contentRange:null});
});
test('closed, open and suffix byte ranges support browser seeking', () => {
  assert.deepEqual(resolveVideoRange('bytes=10-19',100),{status:206,start:10,end:19,length:10,contentRange:'bytes 10-19/100'});
  assert.equal(resolveVideoRange('bytes=90-',100).length,10);
  assert.equal(resolveVideoRange('bytes=-10',100).start,90);
});
test('last byte and ranges past the end are clamped without overflow', () => {
  assert.equal(resolveVideoRange('bytes=99-99',100).length,1);
  assert.equal(resolveVideoRange('bytes=90-999',100).end,99);
  assert.equal(resolveVideoRange('bytes=-999',100).start,0);
});
test('malformed, multiple, unsatisfiable and unsafe integer ranges fail', () => {
  for (const range of ['bytes=-','bytes=-0','bytes=100-','bytes=20-10','bytes=0-1,4-5','items=0-1','bytes=1.5-2','bytes=9007199254740992-','bytes=0-9007199254740992','bytes=0-\nInjected:1']) {
    rejects(() => resolveVideoRange(range,100),'VIDEO_RANGE_INVALID');
  }
});
test('range admission requires a bounded attested file size', () => {
  for (const size of [0,-1,Infinity,NaN,1.5,videoMaxBytes+1]) rejects(() => resolveVideoRange(null,size),'VIDEO_RANGE_INVALID');
});
