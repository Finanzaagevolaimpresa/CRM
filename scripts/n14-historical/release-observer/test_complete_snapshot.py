"""Offline checks only; PostgreSQL qualification is isolated CI's job."""
import copy
import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import historical_guards as g
import qualify_complete_snapshot as q
import test_historical_observer as fixture


class CompleteSnapshot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture.HistoricalObserver.setUpClass()
        cls.factory = fixture.HistoricalObserver(methodName="runTest")
        cls.raw = (q.isolated.ROOT / "prisma/migrations" / g.MIGRATION / "migration.sql").read_bytes()
        cls.manifest = q.isolated.manifest()

    def state(self, schema, populated=False):
        observed = self.factory.observed(schema, populated)
        result = {key: None for key in q.REQUIRED}
        result.update({f"priorDomain{n}Sha256": hashlib.sha256(str(n).encode()).hexdigest() for n in range(180)})
        result.update(targetDatabase="fai_crm_test", observerActor="postgres", observerReadOnly=True,
                      observerSentinel=q.isolated.SENTINEL, ledger=self.factory.ledger(schema), historicalState=observed)
        for name in ("Lead", "Client"):
            for suffix in ("Count", "Sha256"):
                result[name + suffix] = observed[name + suffix]
        return q.admit(result, schema, self.manifest, self.raw)

    def test_complete_queries_are_frozen_read_only_with_synthetic_identities(self):
        for schema in (69, 70):
            sql = q.query(schema)
            self.assertEqual(sql.count("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;"), 1)
            self.assertIn("'ordinaryRows'", sql)
            self.assertIn("'historicalState'", sql)
            self.assertIn('row_to_json(r)::text', sql)
            self.assertIn('to_jsonb(r)::text', sql)
            self.assertNotIn("2026-11-16T13:00:51.483Z", sql)
            self.assertNotRegex(sql, r"'cm[a-z0-9]{20,30}'")

    def test_query_drift_and_unknown_schema_stop(self):
        with self.assertRaises(g.Stop):
            q.query(68)
        original = Path.read_bytes
        def changed(path):
            data = original(path)
            return data + b"\n" if path.name == "complete-snapshot70.sql" else data
        with patch.object(Path, "read_bytes", changed), self.assertRaisesRegex(g.Stop, "COMPLETE_QUERY_DRIFT"):
            q.query(70)

    def test_unapproved_execution_stops_before_any_transport(self):
        with patch.dict(os.environ, {}, clear=True), patch("subprocess.run", side_effect=AssertionError("NO_PROCESS")), \
             patch("socket.socket", side_effect=AssertionError("NO_NETWORK")), self.assertRaises(g.Stop):
            q.capture(70, self.manifest, self.raw)

    def test_actual_schema_and_read_only_identity_are_required(self):
        value = self.state(70)["complete"]
        for key, wrong in (("targetDatabase", "fai_crm"), ("observerReadOnly", False), ("observerActor", "other"),
                           ("observerSentinel", "missing")):
            bad = copy.deepcopy(value); bad[key] = wrong
            with self.assertRaises(g.Stop):
                q.admit(bad, 70, self.manifest, self.raw)
        with self.assertRaises(g.Stop):
            q.admit(value, 69, self.manifest, self.raw)
        bad = copy.deepcopy(value); bad.pop("sessionsStateSha256")
        with self.assertRaises(g.Stop):
            q.admit(bad, 70, self.manifest, self.raw)

    def test_migration_preserves_every_old_field_and_populated_history(self):
        before, after = self.state(69), self.state(70)
        frozen = copy.deepcopy((before, after))
        q.transition(before, after, self.raw)
        self.assertEqual((before, after), frozen)
        for key in ("sessionsStateSha256", "permissionOverridesSha256", "ordinaryRows", "LeadSha256"):
            changed = copy.deepcopy(after); changed["complete"][key] = "drift"
            with self.assertRaises(g.Stop):
                q.transition(before, changed, self.raw)
        populated = self.state(70, True)
        q.same(populated, copy.deepcopy(populated), self.raw)
        self.assertGreaterEqual(len(q.negative_cases(populated, self.raw)), 180)

    def test_shared_fingerprints_cannot_disagree(self):
        value = self.state(70)["complete"]
        value["LeadSha256"] = "0" * 64
        with self.assertRaisesRegex(g.Stop, "COMPLETE_SHARED_FINGERPRINT_MISMATCH"):
            q.admit(value, 70, self.manifest, self.raw)


if __name__ == "__main__":
    unittest.main()
