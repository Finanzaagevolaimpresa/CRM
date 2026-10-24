SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',tablename) ORDER BY tablename)
   FROM pg_tables WHERE schemaname='public' AND tablename IN ('TechnicalUploadSubmission','TechnicalUploadReview')),
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'name',column_name,'type',data_type,'nullable',is_nullable,'default',column_default) ORDER BY table_name,ordinal_position)
   FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('TechnicalUploadSubmission','TechnicalUploadReview')),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('name',c.conname,'type',c.contype,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conname)
   FROM pg_constraint c WHERE c.conrelid IN ('"TechnicalUploadSubmission"'::regclass,'"TechnicalUploadReview"'::regclass)),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid)) ORDER BY p.proname)
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('fai_technical_upload_atomic','fai_technical_upload_review_atomic')),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'deferrable',t.tgdeferrable,'initiallyDeferred',t.tginitdeferred,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname)
   FROM pg_trigger t WHERE t.tgrelid IN ('"TechnicalUploadSubmission"'::regclass,'"TechnicalUploadReview"'::regclass) AND NOT t.tgisinternal)
);
