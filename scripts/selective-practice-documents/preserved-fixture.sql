-- Synthetic CI only: the caller verifies CI, target DB and its sentinel.
BEGIN;
DO $$ DECLARE uid text:=gen_random_uuid()::text; rid text:=gen_random_uuid()::text;
 cid text:=gen_random_uuid()::text; pid text:=gen_random_uuid()::text;
 gid uuid:=gen_random_uuid(); cmd uuid:=gen_random_uuid(); rev uuid:=gen_random_uuid(); p jsonb; receipt jsonb;
BEGIN
 INSERT INTO "User"(id,email,name,role,"passwordHash","updatedAt") VALUES
 (uid,uid||'@invalid.test','Synthetic schema59 manager','admin','synthetic-unusable',now()),
 (rid,rid||'@invalid.test','Synthetic schema59 recipient','consulente','synthetic-unusable',now());
 INSERT INTO "Client"(id,type,"displayName","salesOwnerId","updatedAt")
 VALUES(cid,'societa','Synthetic schema59 preserved client',uid,now());
 INSERT INTO "TechnicalPractice"(id,"clientId",title,"practiceType","targetEntity","createdById","updatedAt")
 VALUES(pid,cid,'Synthetic schema59 preserved practice','Sintetica','Ente sintetico',uid,now());
 p:=jsonb_build_object('id',gid::text,'revision',1,'approvedById',uid,'contextHash',repeat('0',64),'selection',
  jsonb_build_object('practiceId',pid,'recipientId',rid,'revision',0,'commandId',cmd::text,'fields',jsonb_build_array('title')));
 receipt:=jsonb_build_object('protocol','SELECTIVE_PRACTICE_RECEIPT_V1','commandId',cmd::text,'grantId',gid::text,
  'revisionId',rev::text,'revision',1,'operation','GRANT','fieldCount',1);
 INSERT INTO "SelectivePracticeGrant"(id,"practiceId","recipientId",revision,payload,proof)
 VALUES(gid,pid,rid,1,p,repeat('0',64));
 INSERT INTO "SelectivePracticeCommand"(id,"actorId","sessionId","practiceId","recipientId","expectedRevision",operation,"requestDigest",receipt,"receiptProof")
 VALUES(cmd,uid,gen_random_uuid(),pid,rid,0,'GRANT',repeat('0',64),receipt,repeat('0',64));
 INSERT INTO "SelectivePracticeRevision"(id,"grantId",revision,"commandId",payload,proof)
 VALUES(rev,gid,1,cmd,p,repeat('0',64));
 INSERT INTO "AuditLog"(id,"actorId",event,"entityType","entityId","before","after")
 VALUES(rev::text,uid,'selective_practice_changed','SelectivePracticeRevision',rev::text,
  jsonb_build_object('version',0),jsonb_build_object('version',1,'action','GRANT','fieldCount',1));
END $$;
COMMIT;

