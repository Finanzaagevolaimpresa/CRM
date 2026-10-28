import copy
import hashlib
import unittest
from unittest.mock import patch
import historical_guards as g
import historical_snapshot as s
import qualify_snapshot as q


class HistoricalObserver(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = (q.ROOT / 'prisma/migrations' / g.MIGRATION / 'migration.sql').read_bytes()
        cls.manifest = q.manifest()

    def setUp(self):
        self.network = patch('socket.socket', side_effect=AssertionError('NETWORK_FORBIDDEN'))
        self.process = patch('subprocess.run', side_effect=AssertionError('PROCESS_FORBIDDEN'))
        self.network.start(); self.process.start()
        self.addCleanup(self.network.stop); self.addCleanup(self.process.stop)

    def ledger(self, schema):
        return [dict(migration_name=k, checksum=v, finished=True, rolled_back=False, applied_steps_count=1)
                for k, v in list(self.manifest.items())[:schema]]

    def observed(self, schema, populated=False):
        result = {'historicalStructure': g.metadata(schema, self.raw)}
        for name in g.LEGACY + g.NEW:
            count = 7 if name in g.LEGACY else 2 if populated else 0
            result[name + 'Count'] = count
            result[name + 'Sha256'] = g.digest(name + '-synthetic-history') if count else g.EMPTY
        return result

    def state(self, schema, populated=False):
        return g.bind_snapshot(self.observed(schema, populated), schema, self.ledger(schema), self.manifest, self.raw)

    def env(self):
        return dict(CI='true', GITHUB_ACTIONS='true', APP_ENV='test', RUN_DB_TESTS='1',
                    AI_ORCHESTRATOR_DB_TESTS_CONFIRMED='1', AI_ORCHESTRATOR_DB_TEST_SENTINEL=q.SENTINEL,
                    DATABASE_URL='postgresql://postgres:synthetic-n14-history-only@127.0.0.1:5432/fai_crm_test?schema=public')

    def test_sql_source_and_metadata_function_bodies_are_bound(self):
        self.assertEqual(g.checked_sql(self.raw), self.raw.decode())
        self.assertEqual(len(g.metadata(70, self.raw)['functions']), 4)
        with self.assertRaises(g.Stop): g.metadata(70, self.raw + b'\n')

    def test_complete_69_to_70_preserves_actual_rows_and_audit(self):
        self.assertTrue(g.transition(self.state(69), self.state(70), self.raw))

    def test_prior_policy_response_attribution_and_audit_changes_are_denied(self):
        for name in g.LEGACY:
            with self.subTest(name=name):
                after = self.state(70); after[name + 'Sha256'] = g.digest('changed')
                with self.assertRaises(g.Stop): g.transition(self.state(69), after, self.raw)

    def test_migration_cannot_create_historical_journals_or_audit(self):
        for name in g.NEW:
            with self.subTest(name=name):
                after = self.state(70); after[name + 'Count'] = 1; after[name + 'Sha256'] = g.digest(name)
                with self.assertRaises(g.Stop): g.transition(self.state(69), after, self.raw)

    def test_populated_history_is_preserved_without_assuming_empty(self):
        before = self.state(70, True)
        self.assertTrue(g.same_schema(before, copy.deepcopy(before), self.raw))
        self.assertEqual(q.negative_cases(before, self.raw), list(g.LEGACY + g.NEW))

    def test_missing_or_malformed_fingerprints_are_denied(self):
        for value in (None, True, -1, '1'):
            changed = self.state(70); changed['CommercialLeadHistoricalContactCount'] = value
            with self.subTest(value=value), self.assertRaises(g.Stop): g.admit(changed, self.raw)
        changed = self.state(70); changed['historicalContactAuditSha256'] = g.digest('nonempty')
        with self.assertRaises(g.Stop): g.admit(changed, self.raw)

    def test_structure_checks_each_independent_security_dimension(self):
        cases = [('tables', 'ownerMatches', False), ('tables', 'rowSecurity', True),
                 ('columns', 'nullable', 'YES'), ('triggers', 'enabled', 'D'),
                 ('triggers', 'functionSchema', 'other'), ('triggers', 'definition', 'altered'),
                 ('functions', 'bodySha256', 'a' * 64), ('functions', 'securityDefiner', True),
                 ('constraints', 'validated', False), ('constraints', 'definition', 'CHECK (true)'),
                 ('indexes', 'definition', 'altered')]
        for section, field, replacement in cases:
            with self.subTest(section=section, field=field):
                changed = self.observed(70); row = changed['historicalStructure'][section][0]
                self.assertNotEqual(row[field], replacement); row[field] = replacement
                with self.assertRaises(g.Stop): g.bind_snapshot(changed, 70, self.ledger(70), self.manifest, self.raw)

    def test_old_sla_constraint_must_also_be_exact(self):
        changed = self.observed(69); changed['historicalStructure']['constraints'][0]['definition'] = 'CHECK (true)'
        with self.assertRaises(g.Stop): g.bind_snapshot(changed, 69, self.ledger(69), self.manifest, self.raw)

    def test_source_manifest_rejects_old_prefix_drift(self):
        changed = dict(self.manifest); changed[next(iter(changed))] = 'a' * 64
        with self.assertRaises(g.Stop): g.ledger_binding(self.ledger(70), changed, 70)

    def test_incomplete_duplicate_and_extra_ledger_is_denied(self):
        for mode in ('unfinished', 'rolled_back', 'duplicate', 'checksum', 'extra', 'count', 'boolean_steps'):
            rows = self.ledger(70)
            if mode == 'unfinished': rows[-1]['finished'] = False
            if mode == 'rolled_back': rows[-1]['rolled_back'] = True
            if mode == 'duplicate': rows[-1] = copy.deepcopy(rows[0])
            if mode == 'checksum': rows[-1]['checksum'] = 'a' * 64
            if mode == 'extra': rows.append(copy.deepcopy(rows[-1]))
            if mode == 'count': rows.pop()
            if mode == 'boolean_steps': rows[-1]['applied_steps_count'] = True
            with self.subTest(mode=mode), self.assertRaises(g.Stop): g.ledger_binding(rows, self.manifest, 70)

    def test_actual_schema_cannot_be_projected_before_admission(self):
        called = []
        def previous(before, after):
            called.append((before, after)); return True
        after = self.state(70); after['historicalMigrationSha256'] = 'a' * 64
        with self.assertRaises(g.Stop): g.compare_complete(self.state(69), after, self.raw, previous_database_check=previous, migration=True)
        self.assertEqual(called, [])

    def test_complete_guard_gets_unchanged_full_prior_domains(self):
        before, after = self.state(69), self.state(70)
        domains = ('emailAttemptsSha256', 'inboundCursorsSha256', 'sessionsStateSha256', 'selectedDocumentsSha256')
        for name in domains: before[name] = after[name] = g.digest(name)
        def previous(left, right):
            self.assertEqual(left['schema'], 69); self.assertEqual(right['schema'], 69)
            self.assertEqual(left['migrationManifestSha256'], g.PREFIX69_SHA256)
            return all(left[name] == right[name] for name in domains)
        self.assertTrue(g.compare_complete(before, after, self.raw, previous_database_check=previous, migration=True))
        self.assertEqual(after['schema'], 70)
        for name in domains:
            changed = copy.deepcopy(after); changed[name] = g.digest('different')
            with self.subTest(name=name), self.assertRaises(g.Stop):
                g.compare_complete(before, changed, self.raw, previous_database_check=previous, migration=True)
        for callback in (None, lambda a, b: None, lambda a, b: False):
            with self.assertRaises(g.Stop): g.compare_complete(before, after, self.raw, previous_database_check=callback, migration=True)

    def test_connection_requires_all_isolation_gates(self):
        self.assertTrue(q.connection(self.env()).endswith('/fai_crm_test'))
        for key in self.env():
            changed = self.env(); changed[key] = ''
            with self.subTest(key=key), self.assertRaises(g.Stop): q.connection(changed)

    def test_other_database_host_schema_and_actor_are_denied(self):
        original = self.env()['DATABASE_URL']
        for old, new in [('127.0.0.1', 'localhost'), ('127.0.0.1', 'fai-crm-prod-02'),
                         (':5432/', ':15432/'), ('fai_crm_test', 'fai_crm'), ('schema=public', 'schema=other'),
                         ('postgres:', 'faiadmin:'), ('synthetic-n14-history-only', 'other')]:
            changed = self.env(); changed['DATABASE_URL'] = original.replace(old, new)
            with self.subTest(old=old, new=new), self.assertRaises(g.Stop): q.connection(changed)

    def test_result_identity_is_mandatory(self):
        value = dict(targetDatabase='fai_crm_test', actor='postgres', readOnly=True, sentinel=q.SENTINEL,
                     ledger=self.ledger(70), observed=self.observed(70))
        self.assertEqual(q.bind(value, 70, self.manifest, self.raw)['schema'], 70)
        for key, replacement in [('targetDatabase', 'fai_crm'), ('actor', 'faiadmin'), ('readOnly', False), ('sentinel', '')]:
            changed = copy.deepcopy(value); changed[key] = replacement
            with self.subTest(key=key), self.assertRaises(g.Stop): q.bind(changed, 70, self.manifest, self.raw)

    def test_sql_uses_one_read_only_snapshot_and_no_row_payload(self):
        for schema in (69, 70):
            query = q.query(schema)
            self.assertTrue(query.startswith('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;'))
            self.assertTrue(query.endswith('ROLLBACK;\n'))
            self.assertIn("'historicalStructure'", query)
            self.assertNotIn('SELECT *', query)
            self.assertNotIn('passwordHash', query)
            self.assertNotIn('tokenDigest', query)
            self.assertNotIn('COMMIT;', query)
        with self.assertRaises(g.Stop): s.fingerprint('Lead; DROP TABLE Lead')
        with self.assertRaises(g.Stop): s.fingerprint('AuditLog', "arbitrary event")
        with self.assertRaises(g.Stop): s.snapshot_fields(68)


if __name__ == '__main__':
    unittest.main()
