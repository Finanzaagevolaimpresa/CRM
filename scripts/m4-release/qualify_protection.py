"""CI-only real age round-trip using role-selected, disjoint source repositories."""
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import tarfile
import uuid

from common import digest, exclusive, module, need
from protect48 import execute
from sealed_programs import M1, M1_TREE, M2, M2_TREE


def qualify_protection(c, source, backup, binding, work):
    need(os.environ.get('CI') == os.environ.get('GITHUB_ACTIONS') == 'true' and
         socket.gethostname() != 'fai-crm-prod-02', 'PROTECTION_CI_ONLY')
    role = 'before' if binding['candidate'] == M1 else 'after'
    commit, tree, count = (M1,M1_TREE,48) if role == 'before' else (M2,M2_TREE,49)
    need(binding['candidate'] == commit and binding['candidateTree'] == tree, 'CI_PROTECTION_ROLE')
    program = source/'scripts/n05/recovery_kit.py'
    original = program.read_bytes()
    helpers = Path(__import__('qualify_generated_backup').__file__).parent
    remote = module(helpers/'remote_release.py', 'm4_real_protection_selector', digest(helpers/'remote_release.py'))
    release = remote.Release.__new__(remote.Release)
    release.runtime, release.b, release.c = source, binding, c
    release.source = lambda _: ({},commit,tree,'c'*32)
    remote.OLD = source
    kit = release.protection_kit(role)
    need(kit.ROOT == source, 'CI_PROTECTION_REPOSITORY')
    root = work/'protection'; root.mkdir(mode=0o700)
    config, crypto, operations = (root/n for n in ('configuration','crypto','operations'))
    for path in (config,crypto,operations): path.mkdir(mode=0o700)
    exclusive(config/'synthetic-config',b'synthetic configuration only\n')
    exclusive(crypto/'synthetic-key-material',b'not a production key\n')
    identity = root/'synthetic-age-identity'
    c.run('CI_SYNTHETIC_AGE_IDENTITY',['age-keygen','-o',identity])
    identity.chmod(0o600)
    recipient = c.run('CI_SYNTHETIC_RECIPIENT',['age-keygen','-y',identity]).decode().strip()
    expected = {'environment':'production','project':'fai-crm','source_commit':commit,'source_tree':tree,
        'app_image_id':binding['candidateImage'],'image_provenance':'oci-labels',
        'resource_provenance':'authorized-legacy-compose-identity','migration_count':count,
        'manifest_sha256':digest(backup/'MANIFEST.txt'),'checksums_sha256':digest(backup/'SHA256SUMS')}
    plan = {'schema':kit.SCHEMA,'phase':'protect','data_class':'synthetic','run_id':uuid.uuid4().hex,
        'host':socket.gethostname(),'work_root':str(operations),'tools':kit.tools_binding(),
        'backup_set':str(backup),'expected':expected,'recipient':recipient,
        'configuration_dir':str(config),'cryptographic_dir':str(crypto),
        'configuration_sha256':kit.component_identity(config)['sha256'],
        'cryptographic_sha256':kit.component_identity(crypto)['sha256'],'output':str(root/'bundle.tar')}
    plan_file = root/'plan.json'; exclusive(plan_file,plan)
    result = execute(kit,plan_file,digest(plan_file),commit,tree)
    need(result['status'] == 'PROTECTION_VERIFIED', 'CI_PROTECTION_NOT_VERIFIED')
    originals = {'database-documents':backup,'configuration':config,'cryptographic-material':crypto}
    with tarfile.open(root/'bundle.tar','r:') as outer:
        index = json.load(outer.extractfile('INDEX.json'))
        for name,folder in originals.items():
            encrypted = outer.extractfile(name+'.age').read()
            need(hashlib.sha256(encrypted).hexdigest() == index['components'][name]['sha256'], 'CI_CIPHERTEXT_CHANGED')
            plain = c.run('CI_SYNTHETIC_DECRYPT',['age','--decrypt','-i',identity],data=encrypted,seconds=120)
            with tarfile.open(fileobj=io.BytesIO(plain),mode='r:') as inner:
                need(set(inner.getnames()) == {p.name for p in folder.iterdir()}, 'CI_COMPONENT_MEMBERS')
                for member in inner.getmembers():
                    need(member.isfile() and hashlib.sha256(inner.extractfile(member).read()).hexdigest() ==
                         digest(folder/member.name), 'CI_DECRYPTED_CONTENT_CHANGED')
    need(program.read_bytes() == original, 'CANONICAL_PROTECTION_MODIFIED')
    return {'role':role,'schema':count,'roleRepositorySelected':True,'generatedSetProtected':True,
            'allThreeComponentsDecryptedAndCompared':True,'canonicalSourcesUnchanged':True,
            'productionKeysUsed':False,'productionConnected':False}
