"""Exercise the real fixture generator and runner export block; no Docker/DB/network."""
import os
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = (str(Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe')
        if os.name == 'nt' else 'bash')
HELPER = ROOT / 'scripts/vnx03/synthetic-secrets.sh'
RUNNER = (ROOT / 'scripts/vnx03/run-e2e.sh').read_text(encoding='utf-8')
CALLS = re.findall(r'^vnx03_export_synthetic_secret (VNX03_[A-Z_]+) (hex|base64) (\d+)$',
                   RUNNER, re.MULTILINE)

def invoke(generator, body):
    script = 'set -Eeuo pipefail\nsource "$1"\nopenssl() {\n' + generator + '\n}\n' + body
    return subprocess.run([BASH, '-s', '--', HELPER.as_posix()], input=script,
                          encoding='utf-8', capture_output=True, timeout=15)

def fixture(encoding, size):
    return 'a' * (size * 2) if encoding == 'hex' else ('A' * 43 + '=' if size == 32 else 'A' * 64)

class SyntheticSecrets(unittest.TestCase):
    def test_all_runner_exports_survive_lf_crlf_and_wrapping(self):
        self.assertEqual(len(CALLS), 15)
        self.assertEqual(len({name for name, _, _ in CALLS}), 15)
        for framing in ['lf', 'crlf', 'wrapped']:
            with self.subTest(framing=framing):
                branches = []
                for encoding, size in [('hex', 24), ('hex', 32), ('base64', 32), ('base64', 48)]:
                    value = fixture(encoding, size)
                    if framing == 'wrapped':
                        output = "printf '%s\\r\\n%s\\r\\n' '" + value[:20] + "' '" + value[20:] + "'"
                    else:
                        ending = '\\n' if framing == 'lf' else '\\r\\n'
                        output = "printf '%s" + ending + "' '" + value + "'"
                    branches.append(f"'rand -{encoding} {size}') {output} ;;")
                generator = 'case "$*" in\n' + '\n'.join(branches) + '\n*) return 91 ;;\nesac'
                body = '\n'.join('vnx03_export_synthetic_secret ' + ' '.join(call) for call in CALLS)
                for name, encoding, size in CALLS:
                    body += f'\n[[ "${{{name}}}" == "{fixture(encoding, int(size))}" ]]'
                    # An exported value must also survive a new shell, with no logs of its value.
                    body += f'\n"$BASH" -c \'[[ "${{{name}}}" == "{fixture(encoding, int(size))}" ]]\''
                result = invoke(generator, body)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, '')

    def test_generator_error_is_not_masked_by_export(self):
        result = invoke("printf '%s' '" + fixture('base64', 32) + "'; return 77",
                        'vnx03_export_synthetic_secret VNX03_COMMERCIAL_PASSWORD base64 32\necho REACHED')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr, '')

    def test_malformed_output_is_rejected_without_disclosure(self):
        for value in ['', 'x' * 44, 'A' * 44, 'A' * 43 + '!', ' A' * 22, 'A' * 42 + '=']:
            with self.subTest(length=len(value)):
                result = invoke("printf '%s' '" + value + "'",
                                'vnx03_export_synthetic_secret VNX03_COMMERCIAL_PASSWORD base64 32\necho REACHED')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, '')

    def test_invalid_contract_never_calls_generator(self):
        for arguments in ['PATH hex 24', 'VNX03_TEST hex 16', 'VNX03_TEST base64 24',
                          'VNX03_TEST other 32', 'VNX03_TEST hex 24 extra',
                          "'VNX03_TEST[0]' hex 24"]:
            with self.subTest(arguments=arguments):
                result = invoke('echo GENERATOR_CALLED; return 91',
                                'vnx03_export_synthetic_secret ' + arguments + '\necho REACHED')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, '')

    def test_bad_hex_is_rejected_without_disclosure(self):
        for value in ['g' * 48, 'a' * 47, 'a' * 49, 'a' * 47 + ' ']:
            with self.subTest(length=len(value)):
                result = invoke("printf '%s' '" + value + "'",
                                'vnx03_export_synthetic_secret VNX03_POSTGRES_PASSWORD hex 24\necho REACHED')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, '')

if __name__ == '__main__':
    unittest.main()
