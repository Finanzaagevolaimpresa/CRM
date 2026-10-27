import copy
import unittest
from unittest.mock import patch
import qualify_snapshot as q
import technical_private_guards as g


class IsolatedBoundary(unittest.TestCase):
    def env(self):
        return dict(CI="true", GITHUB_ACTIONS="true", APP_ENV="test", RUN_DB_TESTS="1",
                    TECHNICAL_PRIVATE_ITEM_DB_TESTS="1", AI_ORCHESTRATOR_DB_TESTS_CONFIRMED="1",
                    AI_ORCHESTRATOR_DB_TEST_SENTINEL=q.SENTINEL,
                    DATABASE_URL="postgresql://postgres:synthetic-private-item-only@127.0.0.1:5432/fai_crm_test?schema=public")

    def test_every_missing_isolation_gate_blocks_before_psql(self):
        for key in self.env():
            changed = self.env(); changed.pop(key)
            with self.subTest(key=key), patch.dict(q.os.environ, changed, clear=True), \
                 patch.object(q.subprocess, "run") as run, self.assertRaises(g.Stop):
                try:
                    q.capture(68, b"unused: boundary must fail first")
                finally:
                    run.assert_not_called()

    def test_real_remote_and_alternate_connections_are_rejected(self):
        good = self.env()["DATABASE_URL"]
        for changed in (good.replace("127.0.0.1", "fai-crm-prod-02"),
                        good.replace("fai_crm_test", "fai_crm"),
                        good.replace("5432", "5433"), good.replace("postgres:", "faiadmin:"),
                        good.replace("synthetic-private-item-only", "unapproved"),
                        good.replace("schema=public", "schema=other"), good + "#fragment",
                        good.replace("5432", "invalid")):
            with self.subTest(connection="redacted"), self.assertRaises(g.Stop):
                q.connection({**self.env(), "DATABASE_URL": changed})

    def test_expected_connection_is_synthetic_and_query_is_read_only(self):
        self.assertTrue(q.connection(self.env()).endswith("/fai_crm_test"))
        for schema in (68, 69):
            sql = q.query(schema)
            self.assertTrue(sql.startswith("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;"))
            self.assertTrue(sql.endswith("ROLLBACK;\n"))
            for statement in ("INSERT ", "UPDATE ", "DELETE ", "CREATE ", "ALTER ", "TRUNCATE ", "COMMIT;"):
                self.assertNotIn(statement, sql)
        self.assertNotIn('FROM "TechnicalPrivateItemOrigin"', q.query(68))

    def test_database_identity_is_independently_checked(self):
        result = dict(targetDatabase="fai_crm_test", actor="postgres", readOnly=True,
                      sentinel=q.SENTINEL, ledger=[], observed={})
        for key, bad in (("targetDatabase", "fai_crm"), ("actor", "faiadmin"),
                         ("readOnly", False), ("sentinel", "wrong")):
            changed = copy.deepcopy(result); changed[key] = bad
            with self.subTest(key=key), patch.object(q.s, "bind_snapshot") as binder, self.assertRaises(g.Stop):
                try:
                    q.bind(changed, 69, {}, b"")
                finally:
                    binder.assert_not_called()

    def test_query_error_is_redacted(self):
        class Failed:
            returncode = 1
            stdout = ""
            stderr = "PRIVATE_CONNECTION_OR_ROW_CONTENT"
        with patch.dict(q.os.environ, self.env(), clear=True), patch.object(q.subprocess, "run", return_value=Failed()):
            with self.assertRaisesRegex(g.Stop, "^ISOLATED_OBSERVER_READ_FAILED$"):
                q.capture(68, b"")

    def test_actual_candidate_has_exact_sql69_and_full_prefix(self):
        manifest = q.manifest()
        self.assertEqual(len(manifest), 69)
        self.assertEqual(list(manifest)[-1], g.MIGRATION)
        self.assertEqual(manifest[g.MIGRATION], g.SQL_SHA256)
        raw = (q.ROOT / "prisma/migrations" / g.MIGRATION / "migration.sql").read_bytes()
        self.assertEqual(len(g.qualified_metadata(raw)["triggers"]), 8)


if __name__ == "__main__":
    unittest.main()
