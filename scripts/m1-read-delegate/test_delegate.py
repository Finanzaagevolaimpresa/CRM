"""Focused negative tests; no SSH, Docker or real configuration changes."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
if os.name == 'nt':
    sys.modules.setdefault('pwd', types.SimpleNamespace(getpwnam=None))


def module(name):
    spec = importlib.util.spec_from_file_location('test_' + name, ROOT / (name + '.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


d = module('delegate')
i = module('install')
o = module('observe_image_store_r22')
builder = module('build_owner_package')


class Tests(unittest.TestCase):
    def test_owner_package_is_bound_without_execution(self):
        import ast
        with tempfile.TemporaryDirectory() as td:
            output=Path(td)/'package'
            files=builder.build(output)
            for name,entry in files.items():
                raw=(output/name).read_bytes()
                self.assertEqual(hashlib.sha256(raw).hexdigest(),entry['sha256'])
                if name.endswith('.py'):
                    ast.parse(raw)
            owner=(output/'install.owner.py').read_text(encoding='utf8')
            self.assertIn(files['install.bundle.py']['sha256'],owner)
            self.assertIn("owner.admit(c.load(PACKAGE/'package.json'))",owner)
            self.assertNotIn('stage_call',owner)
            with self.assertRaises(FileExistsError):
                builder.build(output)

    def test_exact_sudo_rule_and_no_root_target(self):
        self.assertEqual(i.SUDOERS.decode(), 'fai-codex fai-crm-prod-02=(faiadmin) NOPASSWD: NOSETENV: /usr/bin/python3.14 -I -B -S /usr/local/lib/fai-crm-m1-r23-read/delegate.py\n')

    def test_pinned_existing_observer(self):
        self.assertEqual(hashlib.sha256((ROOT / 'observe_image_store_r22.py').read_bytes()).hexdigest(), d.OBSERVER_SHA)
        self.assertEqual(i.FILES['observe_image_store_r22.py'], d.OBSERVER_SHA)

    def test_pinned_delegate(self):
        self.assertEqual(hashlib.sha256((ROOT / 'delegate.py').read_bytes()).hexdigest(), i.FILES['delegate.py'])

    def test_payload_accepts_only_pinned_bytes(self):
        p = {name: base64.b64encode((ROOT / name).read_bytes()).decode() for name in i.FILES}
        self.assertEqual(set(i.payload_files(p)), set(i.FILES))
        for name in p:
            bad = p | {name: base64.b64encode(b'other').decode()}
            with self.assertRaisesRegex(ValueError, 'PAYLOAD_HASH'):
                i.payload_files(bad)
        with self.assertRaisesRegex(ValueError, 'PAYLOAD_FILE_SET'):
            i.payload_files(p | {'../../etc/sudoers': ''})

    def test_stop_does_not_forward_details_or_arbitrary_error(self):
        r = d.project({'protocol': 'FAI_M1_IMAGE_STORE_READONLY_R22', 'readOnly': True,
            'status': 'STOP', 'code': '/secret value', 'details': {'secret': 'private'}})
        self.assertNotIn('details', r)
        self.assertEqual(r['observationCode'], 'REDACTED')

    def test_unknown_protocol_rejected(self):
        with self.assertRaisesRegex(ValueError, 'OBSERVER_PROTOCOL'):
            d.project({'protocol': 'OTHER', 'readOnly': True})

    def test_not_readonly_rejected(self):
        with self.assertRaisesRegex(ValueError, 'OBSERVER_NOT_READONLY'):
            d.project({'protocol': 'FAI_M1_IMAGE_STORE_READONLY_R22', 'readOnly': False})

    def test_receipt_missing_fields_and_extra_fields_rejected(self):
        for r in ({}, {'secret': 'private'}):
            with self.assertRaisesRegex(ValueError, 'OBSERVER_RECEIPT_UNEXPECTED'):
                d.project(r | {'protocol': 'FAI_M1_IMAGE_STORE_READONLY_R22', 'readOnly': True, 'status': 'OBSERVATION_COMPLETE'})

    def test_image_evidence_config_or_manifest(self):
        configs = {'candidate': {'os': 'linux', 'architecture': 'amd64', 'rootfs': {'diff_ids': ['layer']}}}
        binding = {'candidate': 'commit', 'candidateTree': 'tree'}
        obs = {'id': o.CONFIG_IDS['candidate'], 'os': 'linux', 'architecture': 'amd64', 'layers': ['layer'], 'commit': 'commit', 'tree': 'tree'}
        for identity, kind in [(o.CONFIG_IDS['candidate'], 'CONFIG_DIGEST'), (o.MANIFEST_IDS['candidate'], 'ARCHIVE_OCI_MANIFEST')]:
            result = o.image_evidence('candidate', obs | {'id': identity}, configs, binding)
            self.assertEqual(result['idKind'], kind)
            self.assertTrue(result['layersMatchQualifiedConfig'] and result['qualifiedLabelsMatch'] and result['platformMatches'])
        self.assertFalse(o.image_evidence('candidate', obs | {'layers': ['other']}, configs, binding)['layersMatchQualifiedConfig'])
        self.assertFalse(o.image_evidence('candidate', obs | {'commit': 'other'}, configs, binding)['qualifiedLabelsMatch'])
        self.assertEqual(o.image_evidence('candidate', obs | {'id': 'sha256:'+'f'*64}, configs, binding)['idKind'], 'UNEXPECTED_ID')

    @unittest.skipIf(os.name == 'nt', 'POSIX permissions exercised by Linux CI')
    def test_protection_rejects_writable_or_linked_path(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            p = root / 'file'
            p.write_text('value')
            # /tmp is writable: the full chain is rejected even if the leaf is protected.
            with self.assertRaisesRegex(ValueError, 'UNPROTECTED_PROGRAM_PATH'):
                d.protected(p)
            q = root / 'link'
            q.symlink_to(p)
            with self.assertRaisesRegex(ValueError, 'UNPROTECTED_PROGRAM_PATH'):
                d.protected(q)

    @unittest.skipIf(os.name == 'nt', 'POSIX exclusive creation')
    def test_exclusive_create_does_not_claim_existing_file(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / 'existing'
            p.write_bytes(b'preserved')
            created = []
            with self.assertRaises(FileExistsError):
                i.create(p, b'new', created=created)
            self.assertEqual(created, [])
            self.assertEqual(p.read_bytes(), b'preserved')

    @unittest.skipIf(os.name == 'nt', 'POSIX identity')
    def test_wrong_identity_stops_before_any_program(self):
        with patch.object(d.socket, 'gethostname', return_value='other-host'), patch.object(d.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'DELEGATION_IDENTITY_OR_ARGUMENTS'):
                d.run()
            spawn.assert_not_called()


@unittest.skipUnless(os.name != 'nt' and hasattr(os, 'getuid') and os.getuid() == 0,
                     'Real ownership and rollback are tested as root only in isolated Linux CI')
class InstallationLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        (self.base / 'etc').mkdir()
        (self.base / 'python').write_bytes(b'test executable, never executed')
        self.history = self.base / 'historical-receipt'
        self.history.write_bytes(b'preserve')
        self.patches = contextlib.ExitStack()
        self.patches.enter_context(patch.multiple(i, ROOT=self.base/'installed', RULE=self.base/'etc/rule',
            PYTHON=self.base/'python', PYTHON_SHA=hashlib.sha256((self.base/'python').read_bytes()).hexdigest()))
        self.patches.enter_context(patch.object(i.socket, 'gethostname', return_value='fai-crm-prod-02'))
        self.patches.enter_context(patch.dict(os.environ, SUDO_USER='faiadmin', SUDO_UID='1000'))
        self.patches.enter_context(patch.object(i.pwd, 'getpwnam', side_effect=lambda user:
            types.SimpleNamespace(pw_uid=1000 if user=='faiadmin' else 1001, pw_gid=1000 if user=='faiadmin' else 1001)))
        self.sudo = self.patches.enter_context(patch.object(i, 'check_sudo'))
        # Constrain every test file operation to this synthetic root. No real /etc file is opened.
        def protected(path, directory=False):
            self.assertTrue(path.is_relative_to(self.base))
            for p in [path, *path.parents]:
                if not p.is_relative_to(self.base):
                    break
                s=p.lstat()
                if s.st_uid != 0 or s.st_mode & 0o022 or stat.S_ISLNK(s.st_mode):
                    raise ValueError('PATH_NOT_ROOT_PROTECTED')
            s=path.lstat()
            if not (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink==1):
                raise ValueError('PATH_TYPE')
            return path
        self.patches.enter_context(patch.object(i, 'protected', side_effect=protected))
        self.payload={name:base64.b64encode((ROOT/name).read_bytes()).decode() for name in i.FILES}

    def tearDown(self):
        self.patches.close()
        self.tmp.cleanup()

    def call(self, mode):
        out=io.StringIO()
        with contextlib.redirect_stdout(out):
            rc=i.main(mode,self.payload)
        return rc,json.loads(out.getvalue())

    def test_install_remove_exact_objects(self):
        rc,r=self.call('install')
        self.assertEqual((rc,r['status']),(0,'FIXED_READ_DELEGATION_INSTALLED'))
        self.assertEqual(stat.S_IMODE(i.RULE.stat().st_mode),0o440)
        self.assertEqual(i.RULE.stat().st_uid,0)
        self.assertEqual(stat.S_IMODE((i.ROOT/'delegate.py').stat().st_mode),0o640)
        self.assertEqual((i.ROOT/'delegate.py').stat().st_gid,1000)
        self.assertEqual(self.sudo.call_count,3)
        rc,r=self.call('uninstall')
        self.assertEqual((rc,r['status']),(0,'FIXED_READ_DELEGATION_REMOVED'))
        self.assertFalse(i.RULE.exists() or i.ROOT.exists())
        self.assertEqual(self.history.read_bytes(),b'preserve')

    def test_occupied_destination_never_removed(self):
        i.ROOT.mkdir()
        (i.ROOT/'existing').write_bytes(b'preserve')
        rc,r=self.call('install')
        self.assertEqual(rc,2)
        self.assertEqual(r['code'],'INSTALLATION_PATH_OCCUPIED_RECONCILE_FIRST')
        self.assertEqual((i.ROOT/'existing').read_bytes(),b'preserve')
        self.sudo.assert_not_called()

    def test_validation_failure_after_rule_creation_rolls_back_only_delta(self):
        self.sudo.side_effect=[None,None,ValueError('SUDOERS_VALIDATION_FAILED')]
        rc,r=self.call('install')
        self.assertEqual(rc,2)
        self.assertTrue(r['installationRollbackComplete'])
        self.assertFalse(i.RULE.exists() or i.ROOT.exists())
        self.assertEqual(self.history.read_bytes(),b'preserve')

    def test_changed_installed_file_blocks_removal(self):
        self.assertEqual(self.call('install')[0],0)
        (i.ROOT/'delegate.py').write_bytes(b'changed')
        rc,r=self.call('uninstall')
        self.assertEqual((rc,r['code']),(2,'INSTALLED_PROGRAM_CHANGED'))
        self.assertTrue(i.RULE.exists())

    def test_running_observation_blocks_removal(self):
        import fcntl
        self.assertEqual(self.call('install')[0],0)
        with (i.ROOT/'observation.lock').open('rb') as f:
            fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            rc,r=self.call('uninstall')
            self.assertEqual(rc,2)
            self.assertTrue(i.RULE.exists() and i.ROOT.exists())


if __name__ == '__main__':
    unittest.main()
