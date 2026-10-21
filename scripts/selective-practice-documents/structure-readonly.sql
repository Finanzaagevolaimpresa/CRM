BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='10s';
SELECT json_build_object('functions',(SELECT COALESCE(json_agg(json_build_object('name',p.proname,'schema',n.nspname,
 'arguments',pg_get_function_identity_arguments(p.oid),'returns',pg_get_function_result(p.oid),'language',l.lanname,
 'volatility',p.provolatile,'securityDefiner',p.prosecdef,'configuration',p.proconfig,'ownerMatches',pg_get_userbyid(p.proowner)=CURRENT_USER,
 'bodySha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) ORDER BY p.proname),'[]'::json)
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
 WHERE n.nspname='public' AND p.proname IN ('fai_selective_practice_documents_valid','fai_selective_practice_atomic')),
 'constraints',(SELECT COALESCE(json_agg(json_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid),
 'validated',c.convalidated,'type',c.contype) ORDER BY c.conname),'[]'::json) FROM pg_constraint c
 JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.conname='selective_practice_payload_structure'));
ROLLBACK;

