"""Actual snapshot/controller checks with invented Docker/JSON endpoints.

No daemon, subprocess, credentials, database or production path is accessed.
The Windows sentinel is deliberately unusable: these tests do not cover flock.
"""
import copy
import importlib.util
import json
import pathlib
import sys
import types
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts/n05/failed_app_return.py'


def load_controller(source=SOURCE):
    spec = importlib.util.spec_from_file_location('n05_pg_user_test', source)
    module = importlib.util.module_from_spec(spec)
    if sys.platform == 'win32':
        with mock.patch.dict(sys.modules, {'fcntl': types.ModuleType('unused_fcntl')}):
            spec.loader.exec_module(module)
    else:
        spec.loader.exec_module(module)
    return module


n05 = load_controller()
MISSING = object()


class Fixture:
    def __init__(self, user='', image_user=MISSING, module=n05):
        self.module = module
        image = 'sha256:' + '7' * 64
        self.pg_id = 'f' * 64
        volumes = {key: {'Name': 'fai-crm_' + key, 'Driver': 'local',
                        'Mountpoint': '/invented/' + key, 'CreatedAt': 'synthetic-volume',
                        'Labels': None, 'Options': None, 'Scope': 'local'}
                   for key in ('crm_documents', 'postgres_data')}
        network = {'Id': '6' * 64, 'Name': 'fai-crm_default', 'Created': 'synthetic-network',
                   'Driver': 'bridge', 'Scope': 'local', 'Labels': {}, 'Options': {},
                   'IPAM': {}, 'Internal': False, 'Attachable': False, 'Ingress': False}
        self.rows = 'invented-migration\tchecksum\tstarted\tfinished\t\t1\n'
        self.plan = {'schema': 'FAI_CRM_N05_FAILED_APP_RETURN_V2', 'project': 'fai-crm',
            'engine': {'kind': 'docker', 'host': 'unix:///var/run/docker.sock',
                       'id': 'synthetic-engine', 'name': 'synthetic-host', 'os_type': 'linux'},
            'postgres': {'id': self.pg_id, 'image': image, 'created': 'synthetic-pg'},
            'resources': {'volumes': copy.deepcopy(volumes), 'network': copy.deepcopy(network)},
            'configs': {'previous': {'path': '/invented/frozen.json'}},
            'ledger': {'schema': 'v44', 'count': 1,
                       'digest': module.sha([self.rows.strip('\n').split('\t')])},
            'deadline_epoch': 2000}
        config = {'Env': ['IMAGE_SETTING=one'], 'Cmd': ['postgres'], 'Entrypoint': ['entry']}
        self.pg = {'Id': self.pg_id, 'Image': image, 'Created': 'synthetic-pg',
            'Config': copy.deepcopy(config), 'State': {'Running': True, 'Health': {'Status': 'healthy'}},
            'Mounts': [{'Type': 'volume', 'Name': 'fai-crm_postgres_data',
                        'Destination': '/var/lib/postgresql/data', 'RW': True}],
            'HostConfig': {}, 'NetworkSettings': {'Networks': {'fai-crm_default': {}}}}
        self.pg['Config']['Env'] += ['SYNTHETIC_VALUE=two$three']
        self.image = {'Id': image, 'Config': copy.deepcopy(config)}
        if user is not MISSING:
            self.pg['Config']['User'] = user
        if image_user is not MISSING:
            self.image['Config']['User'] = image_user
        self.model = {'services': {'postgres': {'environment': {'SYNTHETIC_VALUE': 'two$$three'}}}}
        self.volumes, self.network = volumes, network
        self.migrators, self.foreign = [], []
        self.calls = []
        self.engine = module.DockerEngine(self.plan, pathlib.Path('/invented/repo'))
        # All higher-level logic remains real, including inventory, snapshot,
        # ledger parsing and ReturnController._check. Only endpoint I/O is fake.
        self.engine.run = self.run
        self.engine.inspect = self.inspect

    def run(self, *args, **kwargs):
        self.calls.append(args)
        if args == ('info', '--format', '{{json .}}'):
            return json.dumps({'ID': 'synthetic-engine', 'Name': 'synthetic-host', 'OSType': 'linux'})
        if args[0] == 'ps':
            selectors = [args[i + 1] for i, value in enumerate(args[:-1]) if value == '--filter']
            service = next((s for s in selectors if s.startswith('label=com.docker.compose.service=')), None)
            if service:
                return {'app': '', 'postgres': self.pg_id, 'migrate': ' '.join(self.migrators)}[service.split('=')[-1]]
            return ' '.join([self.pg_id, *self.migrators, *self.foreign])
        if args[0] == 'exec' and args[1] == self.pg_id and args[-2] == 'n05-ledger':
            return self.rows
        raise AssertionError('unexpected endpoint or mutation: ' + repr(args))

    def inspect(self, kind, identity, deadline):
        self.calls.append(('inspect', kind, identity))
        if (kind, identity) == ('container', self.pg_id):
            return copy.deepcopy(self.pg)
        if (kind, identity) == ('image', self.plan['postgres']['image']):
            return copy.deepcopy(self.image)
        if kind == 'volume':
            return copy.deepcopy(self.volumes[identity.removeprefix('fai-crm_')])
        if kind == 'network' and identity == 'fai-crm_default':
            return copy.deepcopy(self.network)
        raise AssertionError('unexpected inspect')

    def check(self):
        with mock.patch.object(self.module, 'strict_json', return_value=copy.deepcopy(self.model)):
            return self.module.ReturnController(self.engine, lambda: 1000)._check(self.plan)


class PostgresUserMetadata(unittest.TestCase):
    def denied(self, fixture, code):
        with self.assertRaisesRegex(n05.Denied, '^' + code + '$'):
            fixture.check()
        self.assertTrue(all(call[0] in {'info', 'ps', 'inspect', 'exec'} for call in fixture.calls))

    def test_default_matrix_both_directions(self):
        for left in (MISSING, None, ''):
            for right in (MISSING, None, ''):
                with self.subTest(left=repr(left), right=repr(right)):
                    fixture = Fixture(left, right)
                    result = fixture.check()
                    self.assertEqual(result['postgres'], fixture.plan['postgres'])
                    self.assertEqual(result['ledger'], fixture.plan['ledger'])
                    self.assertEqual(result['resources'], fixture.plan['resources'])
                    self.assertTrue(result['postgres_healthy'])

    def test_explicit_equal_values_are_preserved(self):
        for user in ('postgres', 'root', '0', '1001', '1001:1002', 'postgres:postgres', '00', ' '):
            with self.subTest(user=user):
                fixture = Fixture(user, user)
                fixture.check()
                self.assertEqual(fixture.pg['Config']['User'], user)
                self.assertEqual(fixture.image['Config']['User'], user)

    def test_explicit_differences_are_not_normalized(self):
        pairs = [('root', '0'), ('0', '00'), ('postgres', 'POSTGRES'), ('1001', '1001:1001'),
                 ('1001:1002', '1001:1003'), ('postgres:postgres', 'postgres'), ('', ' ')]
        for left, right in pairs:
            for a, b in ((left, right), (right, left)):
                with self.subTest(left=a, right=b):
                    self.denied(Fixture(a, b), 'POSTGRES_CONFIGURATION_DRIFT')

    def test_default_does_not_match_explicit_root_or_other_user(self):
        for default in (MISSING, None, ''):
            for user in ('root', '0', 'postgres', '1001:1002'):
                for a, b in ((default, user), (user, default)):
                    with self.subTest(default=repr(default), user=user, left=repr(a)):
                        self.denied(Fixture(a, b), 'POSTGRES_CONFIGURATION_DRIFT')

    def test_malformed_user_rejected_even_if_equal(self):
        for value in (False, True, 0, 1, 0.0, [], {}, ['postgres'], {'name': 'postgres'}):
            for left, right in ((value, ''), ('', value), (value, value)):
                with self.subTest(value=repr(value), left=repr(left), right=repr(right)):
                    fixture = Fixture(left, right)
                    self.denied(fixture, 'POSTGRES_USER_METADATA_TYPE_INVALID')
                    self.assertFalse(any(c[0] == 'exec' for c in fixture.calls))

    def test_env_drift_still_stops_before_ledger(self):
        for target in ('pg', 'image', 'model'):
            fixture = Fixture('', MISSING)
            if target == 'model':
                fixture.model['services']['postgres']['environment']['SYNTHETIC_VALUE'] = 'changed'
            else:
                getattr(fixture, target)['Config']['Env'].append('UNEXPECTED=invented')
            self.denied(fixture, 'POSTGRES_CONFIGURATION_DRIFT')
            self.assertFalse(any(c[0] == 'exec' for c in fixture.calls))

    def test_cmd_and_entrypoint_drift_both_directions(self):
        for field in ('Cmd', 'Entrypoint'):
            for target in ('pg', 'image'):
                fixture = Fixture('', None)
                getattr(fixture, target)['Config'][field] = ['changed']
                self.denied(fixture, 'POSTGRES_CONFIGURATION_DRIFT')

    def test_pg_id_image_created_must_remain_exact(self):
        for field in ('Id', 'Image', 'Created'):
            fixture = Fixture('', MISSING)
            fixture.pg[field] = 'replaced'
            self.denied(fixture, 'POSTGRES_IDENTITY_DRIFT')

    def test_mount_authority_and_network_still_rejected(self):
        fixture = Fixture(); fixture.pg['Mounts'][0]['RW'] = False
        self.denied(fixture, 'POSTGRES_MOUNT_DRIFT')
        for field, value in (('Privileged', True), ('CapAdd', ['SYS_ADMIN']), ('Devices', ['/invented'])):
            fixture = Fixture(); fixture.pg['HostConfig'][field] = value
            self.denied(fixture, 'POSTGRES_RUNTIME_AUTHORITY_DRIFT')
        fixture = Fixture(); fixture.pg['NetworkSettings']['Networks']['unexpected'] = {}
        self.denied(fixture, 'POSTGRES_RUNTIME_AUTHORITY_DRIFT')

    def test_resource_drift_is_rejected_by_actual_controller(self):
        fixture = Fixture(); fixture.volumes['postgres_data']['CreatedAt'] = 'replaced'
        self.denied(fixture, 'PERSISTENT_RESOURCE_DRIFT')
        fixture = Fixture(); fixture.network['Id'] = '0' * 64
        self.denied(fixture, 'PERSISTENT_RESOURCE_DRIFT')

    def test_health_migrator_foreign_and_ledger_guards_remain(self):
        fixture = Fixture(); fixture.pg['State']['Health']['Status'] = 'unhealthy'
        self.denied(fixture, 'POSTGRES_NOT_HEALTHY')
        fixture = Fixture(); fixture.migrators = ['a' * 64]
        self.denied(fixture, 'MIGRATOR_PRESENT')
        fixture = Fixture(); fixture.foreign = ['b' * 64]
        self.denied(fixture, 'FOREIGN_CONTAINER_PRESENT')
        fixture = Fixture(); fixture.rows = fixture.rows.replace('checksum', 'changed')
        self.denied(fixture, 'LEDGER_DRIFT')


if __name__ == '__main__':
    unittest.main(verbosity=2)
