-- Synthetic historical V1/V2 rows; proofs deliberately unusable by runtime.
BEGIN;
DO $$ DECLARE uid text:=gen_random_uuid()::text; rid text:=gen_random_uuid()::text;
 cid text; coid text; did text; vid text; gid uuid; cmd uuid; rev uuid; p jsonb; receipt jsonb; s jsonb; ver integer;
BEGIN
 INSERT INTO "User"(id,email,name,role,"passwordHash","updatedAt") VALUES
 (uid,uid||'@invalid.test','Synthetic schema60 manager','admin','synthetic-unusable',now()),
 (rid,rid||'@invalid.test','Synthetic schema60 recipient','commerciale','synthetic-unusable',now());
 FOR ver IN 1..2 LOOP
  cid:=gen_random_uuid()::text; coid:=gen_random_uuid()::text; did:=gen_random_uuid()::text; vid:=gen_random_uuid()::text;
  gid:=gen_random_uuid();cmd:=gen_random_uuid();rev:=gen_random_uuid();
  INSERT INTO "Client"(id,type,"displayName","salesOwnerId","updatedAt") VALUES(cid,'societa','Synthetic preserved company client',uid,now());
  INSERT INTO "Company"(id,"clientId",name,"vatNumber","updatedAt") VALUES(coid,cid,'Synthetic preserved company','SYNTHETIC_VAT',now());
  INSERT INTO "Document"(id,"clientId","companyId",type,title,"fileName","mimeType","sizeBytes","storagePath","uploadedById","updatedAt")
   VALUES(did,cid,coid,'altro','Synthetic V2 preserved document','preserved.txt','text/plain',9,'synthetic/not-a-real-file',uid,now());
  INSERT INTO "DocumentVersion"(id,"documentId",version,"storagePath",checksum) VALUES(vid,did,1,'synthetic/not-a-real-file',repeat('0',64));
  s:=jsonb_build_object('clientId',cid,'recipientId',rid,'revision',0,'commandId',cmd::text,'fields',jsonb_build_array('displayName'));
  p:=jsonb_build_object('id',gid::text,'revision',1,'approvedById',uid,'selection',s);
  receipt:=jsonb_build_object('protocol','SELECTIVE_CLIENT_RECEIPT_V1','commandId',cmd::text,'grantId',gid::text,
   'revisionId',rev::text,'revision',1,'operation','GRANT','fieldCount',1);
  IF ver=2 THEN
   p:=jsonb_set(p,'{selection}',s||jsonb_build_object('version',2,'documents',jsonb_build_array(jsonb_build_object('versionId',vid,'download',false))))
    || jsonb_build_object('documents',jsonb_build_array(jsonb_build_object('documentId',did,'versionId',vid,'version',1,'download',false,
     'checksum',repeat('0',64),'stateHash',repeat('0',64),'title','Synthetic V2 preserved document','fileName','preserved.txt','mimeType','text/plain')));
   receipt:=receipt||jsonb_build_object('protocol','SELECTIVE_CLIENT_RECEIPT_V2','documentCount',1);
  END IF;
  INSERT INTO "SelectiveClientGrant"(id,"clientId","recipientId",revision,payload,proof) VALUES(gid,cid,rid,1,p,repeat('0',64));
  INSERT INTO "SelectiveClientCommand"(id,"actorId","sessionId","clientId","recipientId","expectedRevision",operation,"requestDigest",receipt,"receiptProof")
   VALUES(cmd,uid,gen_random_uuid(),cid,rid,0,'GRANT',repeat('0',64),receipt,repeat('0',64));
  INSERT INTO "SelectiveClientRevision"(id,"grantId",revision,"commandId",payload,proof) VALUES(rev,gid,1,cmd,p,repeat('0',64));
  INSERT INTO "AuditLog"(id,"actorId",event,"entityType","entityId","before","after") VALUES(rev::text,uid,'selective_client_changed','SelectiveClientRevision',rev::text,
   jsonb_build_object('version',0),jsonb_build_object('version',1,'action','GRANT','fieldCount',1)||CASE WHEN ver=2 THEN jsonb_build_object('documentCount',1) ELSE '{}'::jsonb END);
 END LOOP;
END $$;
COMMIT;
