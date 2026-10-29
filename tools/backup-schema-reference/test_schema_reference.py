import unittest
from unittest.mock import Mock
import schema_reference as s

class ReferenceTests(unittest.TestCase):
    def test_parser_output_not_original_printing_is_compared(self):
        source=b'CREATE TABLE synthetic (x varchar CHECK (x IN (\'A\',\'B\')));'
        canonical=b'CREATE TABLE synthetic (x varchar CHECK ((x)::text = ANY (ARRAY[\'A\'::text,\'B\'::text])));'
        prepare=Mock()
        proof=s.compare(source,s.fingerprint(source),prepare,lambda:canonical,lambda:canonical)
        prepare.assert_called_once_with(source)
        self.assertTrue(proof['allSchemaBytesCompared']);self.assertFalse(proof['ddlExceptionsApplied'])
    def test_changed_source_stops_before_loading_any_database(self):
        prepare=Mock()
        with self.assertRaisesRegex(s.SchemaMismatch,'SOURCE_CHANGED'):
            s.compare(b'CREATE TABLE x();','0'*64,prepare,Mock(),Mock())
        prepare.assert_not_called()
    def test_schema_loss_and_weakening_always_fail(self):
        source=b'CREATE TABLE x(a int CHECK (a>0));'
        for changed in (b'CREATE TABLE x(a int);',b'CREATE TABLE x(a int CHECK (a>=0));',b'CREATE TABLE x(a text);'):
            with self.subTest(changed=changed),self.assertRaisesRegex(s.SchemaMismatch,'MISMATCH'):
                s.compare(source,s.fingerprint(source),Mock(),lambda:source,lambda:changed)
    def test_order_and_whitespace_are_not_erased(self):
        for a,b in [(b'CREATE A;\nCREATE B;',b'CREATE B;\nCREATE A;'),(b'CHECK (x>0)',b'CHECK (x >0)')]:
            with self.assertRaises(s.SchemaMismatch):s.compare(a,s.fingerprint(a),Mock(),lambda:a,lambda:b)
    def test_comments_and_function_bodies_are_preserved(self):
        a=b'-- application invariant\nCREATE FUNCTION f() RETURNS text AS $$RETURN \'a\';$$ LANGUAGE plpgsql;'
        for b in (a.replace(b'invariant',b'changed'),a.replace(b"'a'",b"'b'")):
            with self.assertRaises(s.SchemaMismatch):s.compare(a,s.fingerprint(a),Mock(),lambda:a,lambda:b)
    def test_dump_nonces_only_do_not_change_schema(self):
        a=b'\\restrict abc\nCREATE TABLE x();\n\\unrestrict abc\n'
        b=a.replace(b'abc',b'xyz')
        self.assertEqual(s.fingerprint(a),s.fingerprint(b))
    def test_load_failure_cannot_produce_proof(self):
        a=b'CREATE TABLE x();'
        with self.assertRaisesRegex(RuntimeError,'load'):
            s.compare(a,s.fingerprint(a),Mock(side_effect=RuntimeError('load')),Mock(),Mock())
    def test_bounds_and_invalid_utf8(self):
        for value in (b'',b'a'*(s.MAX_SCHEMA_BYTES+1)):
            with self.assertRaises(s.SchemaMismatch):s.normalize(value)
        with self.assertRaises(UnicodeDecodeError):s.normalize(b'\xff')
    def test_existing_reference_is_not_reused(self):
        c=Mock();c.docker.return_value=b'1\n';source=b'CREATE TABLE x();'
        with self.assertRaisesRegex(s.SchemaMismatch,'ALREADY_EXISTS'):
            s.helper_qualify(c,'synthetic-helper',source,s.fingerprint(source))
        self.assertEqual(c.docker.call_count,1)

if __name__=='__main__':unittest.main(verbosity=2)
