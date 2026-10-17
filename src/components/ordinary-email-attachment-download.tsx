'use client';
import { useRef, useState, useSyncExternalStore } from 'react';

const subscribe=()=>()=>{};

export function OrdinaryEmailAttachmentDownload({ replyId, file, downloadName }: {
  replyId:string; file:{ordinal:number;filename:string;bytes:number;sha256:string;payloadHash:string}; downloadName:string;
}) {
  const busy=useRef(false),[pending,setPending]=useState(false),[error,setError]=useState('');
  const ready=useSyncExternalStore(subscribe,()=>true,()=>false);
  return <form method="post" action={`/communications/replies/${replyId}/attachments/${file.ordinal}`}
    data-attachment-ready={String(ready)} className="rounded-xl border p-3" onSubmit={async event=>{
      event.preventDefault(); if(busy.current)return; busy.current=true;setPending(true);setError('');
      const data=new FormData(event.currentTarget);
      try {
        const response=await fetch(event.currentTarget.action,{method:'POST',body:data,cache:'no-store'});
        if(!response.ok || response.headers.get('content-type')!=='application/octet-stream'
          || response.headers.get('content-length')!==String(file.bytes)) throw new Error('UNAVAILABLE');
        const bytes=await response.arrayBuffer();
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
        if(bytes.byteLength!==file.bytes||hash!==file.sha256)throw new Error('INTEGRITY');
        const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})),link=document.createElement('a');
        link.href=url;link.download=downloadName;link.click();setTimeout(()=>URL.revokeObjectURL(url),30_000);
      }catch{setError('Download non riuscito. Aggiorna la pratica prima di riprovare.');}
      finally{busy.current=false;setPending(false);}
    }}>
    <input type="hidden" name="payloadHash" value={file.payloadHash} />
    <input type="hidden" name="attachmentHash" value={file.sha256} />
    <p className="break-words">{file.filename} · {file.bytes} byte</p>
    <button type="submit" disabled={!ready||pending} className="font-bold underline disabled:opacity-50">
      {pending?'Download in corso…':`Scarica allegato ${file.ordinal+1}`}
    </button>
    {error?<p role="alert" className="mt-2 text-red-700">{error}</p>:null}
  </form>;
}
