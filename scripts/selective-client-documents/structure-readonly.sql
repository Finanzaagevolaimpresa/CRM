-- Synthetic CI metadata only; no document rows or credentials.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='10s';
SELECT json_build_object('column',(SELECT COALESCE(json_agg(json_build_object('type',data_type,'nullable',is_nullable,'default',column_default)),'[]'::json)
      FROM information_schema.columns WHERE table_schema='public' AND table_name='Document' AND column_name='selectiveEpoch'),'triggers',(SELECT COALESCE(json_agg(json_build_object('schema_name',n.nspname,'table_name',c.relname,'trigger_name',t.tgname,
      'enabled',t.tgenabled,'deferrable',t.tgdeferrable,'initially_deferred',t.tginitdeferred,'function_schema',pn.nspname,
      'function_name',p.proname,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname),'[]'::json)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
      WHERE NOT t.tgisinternal AND t.tgname IN ('selected_document_epoch','selected_document_version_epoch','selected_document_contract_epoch','selected_document_payment_epoch','selected_document_formalization_epoch','selected_document_material_epoch','selected_document_company_epoch','selected_document_readiness_epoch')),'functions',(SELECT COALESCE(json_agg(json_build_object('name',p.proname,'schema',n.nspname,
      'arguments',pg_get_function_identity_arguments(p.oid),'returns',pg_get_function_result(p.oid),'language',l.lanname,
      'volatility',p.provolatile,'securityDefiner',p.prosecdef,'configuration',p.proconfig,
      'ownerMatches',pg_get_userbyid(p.proowner)=CURRENT_USER,
      'bodySha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) ORDER BY p.proname),'[]'::json)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
      WHERE n.nspname='public' AND p.proname IN ('fai_selected_document_epoch','fai_selected_document_reference_epoch','fai_selected_document_context_epoch','fai_selective_client_documents_valid','fai_selective_client_atomic')),'constraints',(SELECT COALESCE(json_agg(json_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid),
      'validated',c.convalidated,'type',c.contype) ORDER BY c.conname),'[]'::json) FROM pg_constraint c
      JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.conname IN ('Document_selectiveEpoch_check','selective_client_payload_structure')));
ROLLBACK;
