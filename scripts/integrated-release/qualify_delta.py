"""Real isolated schema49 backup/recovery, with read-only session/mailbox guards."""
from pathlib import Path
import sys
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parent))
from generate import pinned, change


def readonly_fixture(raw):
    raw=change(raw,
        "sys.path.insert(0,str(HERE))\nsys.path.insert(1,str(REPO/'scripts/m1-assisted'))",
        "helper_paths=[str(HERE),str(HELPERS),str(REPO/'scripts/m1-assisted')]\n"
        "sys.path[:]=helper_paths+[p for p in sys.path if p not in helper_paths]")
    raw=change(raw,
        'from registry_settlement import SQL, PREFLIGHT_SQL, COUNT_SQL, parse_counts',
        'from registry_settlement import SQL, PREFLIGHT_SQL, COUNT_SQL, parse_counts\n'
        'import qualified_images, registry_settlement\n'
        "need(all(Path(m.__file__).resolve().parent==HELPERS.resolve() for m in (qualified_images,registry_settlement)),\n"
        "     'CI_MUST_EXERCISE_GENERATED_HELPERS')")
    a=raw.index("        need(parse_counts(sql(PREFLIGHT_SQL))==")
    b=raw.index("        backup=work/'set49'",a)
    raw=raw[:a]+'''        full_identity = lambda:sql('SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY id)::text) FROM "InternalSession" s;')
        untouched=full_identity()
        for command in (PREFLIGHT_SQL,SQL):
            try:parse_counts(sql(command))
            except ValueError as exc:need(str(exc)=='LIVE_SESSIONS_REQUIRE_NORMAL_LOGOUT','WRONG_READONLY_DENIAL')
            else:raise Stop('LIVE_SESSIONS_NOT_DENIED')
        need(full_identity()==untouched and sql(COUNT_SQL)=='2' and audit_count()=='0','READONLY_GUARD_WROTE_ROWS')
        # Explicit synthetic fixture expiry, never part of a production helper.
        sql("UPDATE \\\"InternalSession\\\" SET \\\"expiresAt\\\"=CURRENT_TIMESTAMP-INTERVAL '1 minute';")
        untouched=full_identity()
        counts=parse_counts(sql(SQL))
        need(counts=={'revokedCount':0,'auditCount':0} and audit_count()=='0' and full_identity()==untouched,
             'EMPTY_REGISTRY_GUARD_WROTE_ROWS')
        from mailbox_guard import observe as observe_mailboxes
        sql(\'''UPDATE "CommunicationMailbox" SET enabled=true,"canSend"=true,"canReceive"=true,
          kind='MAILBOX',"providerReference"='SYNTHETIC_ONLY',
          "configuredRevision"=revision,"testedRevision"=revision,
          "configurationReference"='SYNTHETIC_CONFIG',"testReference"='SYNTHETIC_TEST',"testedAt"=CURRENT_TIMESTAMP,
          "responsibleUserId"=(SELECT id FROM "User" WHERE email='m2-r26@example.invalid');\''')
        boxes_before=observe_mailboxes(sql)
        need(observe_mailboxes(sql)==boxes_before,'READONLY_MAILBOX_GUARD_CHANGED_ROWS')
''' + raw[b:]
    raw=raw.replace("'auditFailureAtomicRollback':True", "'liveSessionDenialWithoutWrites':True")
    raw=raw.replace("'registryReadyAfterSettlement':True", "'registryReadyAfterSyntheticExpiry':True")
    raw=raw.replace("'auditedRevocationCounts':counts", "'readOnlyRegistryCounts':counts,'qualifiedMailboxes':boxes_before")
    raw=change(raw,"        no_migration=exercise(HELPERS,work/'admission-proof',binding,rows)",
        "        need(observe_mailboxes(sql)==boxes_before and full_identity()==untouched and audit_count()=='0','RECOVERY_CHANGED_SOURCE_DATA')\n        no_migration=exercise(HELPERS,work/'admission-proof',binding,rows)")
    return raw


raw=pinned('scripts/m5-release/qualify_delta.py').decode()
raw=raw.replace('from generate import source, render, SOURCE, SOURCE_TREE, schema49',
                'from generate import source, render, SOURCE, SOURCE_TREE, schema49, pinned')
raw=raw.replace("source('scripts/m4-release/qualification.json')", "pinned('scripts/m5-release/qualification.json')")
raw=change(raw, "'candidateCiImage':proof['candidateImageId'],'returnCiImage':proof['recoveryImageId'],",
           "'candidateCiImage':proof['candidateImageId'],'returnCiImage':proof['recoveryImageId'],\n        'returnCommit':proof['recoveryCommit'],'returnTree':proof['recoveryTree'],")
raw=raw.replace('m5-release-ci-receipt.json','r40-release-ci-receipt.json')
raw=raw.replace('FAI_M5_RELEASE_DELTA_QUALIFICATION_R36','FAI_R40_RELEASE_DELTA_QUALIFICATION_R64')
raw=change(raw,"    exec(compile(raw,'qualified_m5_schema49_harness.py','exec'),globals())",
           "    exec(compile(readonly_fixture(raw),'qualified_r40_schema49_harness.py','exec'),globals())")
exec(compile(raw,'pinned_m5_qualification.py','exec'),globals())
