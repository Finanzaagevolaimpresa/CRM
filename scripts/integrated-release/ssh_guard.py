"""One protected SSH argument set for profile admission and every connection."""
from common import need

OPTIONS = [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'CheckHostIP=no',
    '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
    '-o', 'ForwardX11Trusted=no', '-o', 'Tunnel=no', '-o', 'PermitLocalCommand=no',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'AddKeysToAgent=no', '-o', 'VerifyHostKeyDNS=no', '-o', 'KnownHostsCommand=none',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
]
REQUIRED = {
    'batchmode': {'yes', 'true'},
    'stricthostkeychecking': {'yes', 'true'},
    'updatehostkeys': {'no', 'false'},
    'checkhostip': {'no', 'false'},
    'clearallforwardings': {'yes', 'true'},
    'forwardagent': {'no', 'false'},
    'forwardx11': {'no', 'false'},
    'forwardx11trusted': {'no', 'false'},
    'permitlocalcommand': {'no', 'false'},
    'verifyhostkeydns': {'no', 'false'},
    'addkeystoagent': {'no', 'false'},
}
TARGET = {'hostname': 'desk.finanzaagevolaimpresa.it', 'user': 'faiadmin', 'port': '22'}


def validate_profile(output):
    fields = {}
    for line in output.decode('utf-8', 'replace').splitlines():
        key, _, value = line.partition(' ')
        if key in TARGET or key in REQUIRED:
            need(key not in fields, 'SSH_PROFILE_AMBIGUOUS')
            fields[key] = value.strip()
    need({key: fields.get(key) for key in TARGET} == TARGET, 'SSH_ALIAS_TARGET_MISMATCH')
    need(all(fields.get(key) in allowed for key, allowed in REQUIRED.items()),
         'SSH_PROTECTED_OPTIONS_NOT_ENFORCED')


def verify_profile(call, ssh_args):
    code, output, _ = call(ssh_args[:-1] + ['-G', ssh_args[-1]], 10)
    need(code == 0, 'LOCAL_SSH_PROFILE_QUERY_FAILED')
    validate_profile(output)
