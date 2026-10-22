-- CI-only populated V3 history plus pre-existing person and relationship bytes.
BEGIN;
DO $$ DECLARE uid text:=gen_random_uuid()::text; rid text:=gen_random_uuid()::text;
 cid text:=gen_random_uuid()::text; coid text:=gen_random_uuid()::text; pid text:=gen_random_uuid()::text;
 gid uuid:=gen_random_uuid(); cmd uuid:=gen_random_uuid(); rev uuid:=gen_random_uuid(); p jsonb; receipt jsonb; s jsonb;
BEGIN
 INSERT INTO "User"(id,email,name,role,"passwordHash","updatedAt") VALUES
 (uid,uid||'@invalid.test','Synthetic schema61 manager','admin','synthetic-unusable',now()),
 (rid,rid||'@invalid.test','Synthetic schema61 recipient','commerciale','synthetic-unusable',now());
 INSERT INTO "Client"(id,type,"displayName","salesOwnerId","updatedAt") VALUES(cid,'societa','Synthetic preserved person client',uid,now());
 INSERT INTO "Company"(id,"clientId",name,"vatNumber","updatedAt") VALUES(coid,cid,'Synthetic preserved person company','SYNTHETIC_VAT',now());
 INSERT INTO "Person"(id,"firstName","lastName",email,phone,"taxCode",notes) VALUES(pid,'Synthetic','Preserved','preserved@example.invalid','Synthetic phone','Synthetic tax','Private preserved note');
 INSERT INTO "CompanyPerson"(id,"companyId","personId",role,"ownershipPercent") VALUES(gen_random_uuid()::text,coid,pid,'Referente',12.1234567890123456789);
 s:=jsonb_build_object('version',3,'clientId',cid,'recipientId',rid,'revision',0,'commandId',cmd::text,'fields','[]'::jsonb,'documents','[]'::jsonb,
  'companies',jsonb_build_array(jsonb_build_object('companyId',coid,'fields',jsonb_build_array('vatNumber'))));
 p:=jsonb_build_object('id',gid::text,'revision',1,'approvedById',uid,'selection',s,'documents','[]'::jsonb,
  'companies',jsonb_build_array(jsonb_build_object('companyId',coid,'companyEpoch',1,'stateHash',repeat('0',64))));
 receipt:=jsonb_build_object('protocol','SELECTIVE_CLIENT_RECEIPT_V3','commandId',cmd::text,'grantId',gid::text,
  'revisionId',rev::text,'revision',1,'operation','GRANT','fieldCount',0,'documentCount',0,'companyCount',1,'companyFieldCount',1);
 INSERT INTO "SelectiveClientGrant"(id,"clientId","recipientId",revision,payload,proof) VALUES(gid,cid,rid,1,p,repeat('0',64));
 INSERT INTO "SelectiveClientCommand"(id,"actorId","sessionId","clientId","recipientId","expectedRevision",operation,"requestDigest",receipt,"receiptProof")
  VALUES(cmd,uid,gen_random_uuid(),cid,rid,0,'GRANT',repeat('0',64),receipt,repeat('0',64));
 INSERT INTO "SelectiveClientRevision"(id,"grantId",revision,"commandId",payload,proof) VALUES(rev,gid,1,cmd,p,repeat('0',64));
 INSERT INTO "AuditLog"(id,"actorId",event,"entityType","entityId","before","after") VALUES(rev::text,uid,'selective_client_changed','SelectiveClientRevision',rev::text,
  jsonb_build_object('version',0),jsonb_build_object('version',1,'action','GRANT','fieldCount',0,'documentCount',0,'companyCount',1,'companyFieldCount',1));
END $$;
COMMIT;
