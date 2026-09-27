"""Real age1.3.2 round-trip of a generated schema48 set, CI only."""
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import tarfile
import uuid

from common import digest, exclusive, module, need
from protect48 import execute, qualify
from sealed_programs import M1, M1_TREE, M2, M2_TREE


def qualify_protection(c, source, backup, binding, work):
    need(os.environ.get('CI') == os.environ.get('GITHUB_ACTIONS') == 'true' and
         socket.gethostname() != 'fai-crm-prod-02', 'PROTECTION_CI_ONLY')
    raw_sources = {p: (source/p).read_bytes() for p in
                   ('scripts/n05/recovery_kit.py', 'scripts/n05/verify-backup-manifest.sh')}
    program = source/'scripts/n05/recovery_kit.py'
    kit = module(program, 'ci_original_protect', digest(program))
    try:
        kit.verify_source_schema(M2, M2_TREE, 48)
    except kit.Denied as exc:
        raw = (json.dumps({'status':'DENIED','code':str(exc)})+'\n').encode()
        need(len(raw) == 67 and hashlib.sha256(raw).hexdigest() ==
             '92541c64497e23f3f85104574c6e8d354441ec436da63c18600ff65e94c75e24',
             'CI_R29_FAILURE_NOT_REPRODUCED')
    else:
        raise RuntimeError('CI_R29_FAILURE_NOT_EXERCISED')
    for commit, tree in ((M1,M1_TREE),(M2,M2_TREE)):
        check = qualify(module(program, 'ci_source_'+commit[:8], digest(program)), commit, tree)
        check.verify_source_schema(commit, tree, 48)
    root = work/'protection'
    root.mkdir(mode=0o700)
    config, crypto, operations = (root/n for n in ('configuration','crypto','operations'))
    for path in (config, crypto, operations): path.mkdir(mode=0o700)
    exclusive(config/'synthetic-config', b'synthetic configuration only\n')
    exclusive(crypto/'synthetic-key-material', b'not a real production key\n')
    identity = root/'synthetic-age-identity'
    c.run('CI_SYNTHETIC_AGE_IDENTITY',['age-keygen','-o',identity])
    identity.chmod(0o600)
    recipient = c.run('CI_SYNTHETIC_RECIPIENT',['age-keygen','-y',identity]).decode().strip()
    expected = {'environment':'production','project':'fai-crm','source_commit':M2,'source_tree':M2_TREE,
        'app_image_id':binding['candidateImage'],'image_provenance':'oci-labels',
        'resource_provenance':'authorized-legacy-compose-identity','migration_count':48,
        'manifest_sha256':digest(backup/'MANIFEST.txt'),'checksums_sha256':digest(backup/'SHA256SUMS')}
    plan = {'schema':kit.SCHEMA,'phase':'protect','data_class':'synthetic','run_id':uuid.uuid4().hex,
        'host':socket.gethostname(),'work_root':str(operations),'tools':kit.tools_binding(),
        'backup_set':str(backup),'expected':expected,'recipient':recipient,
        'configuration_dir':str(config),'cryptographic_dir':str(crypto),
        'configuration_sha256':kit.component_identity(config)['sha256'],
        'cryptographic_sha256':kit.component_identity(crypto)['sha256'],'output':str(root/'bundle.tar')}
    plan_file = root/'plan.json'
    exclusive(plan_file, plan)
    result = execute(kit, plan_file, digest(plan_file), M2, M2_TREE)
    need(result['status'] == 'PROTECTION_VERIFIED' and digest(root/'bundle.tar') == result['bundle_sha256'],
         'CI_PROTECTION_NOT_VERIFIED')
    originals = {'database-documents':backup, 'configuration':config, 'cryptographic-material':crypto}
    with tarfile.open(root/'bundle.tar', 'r:') as outer:
        need(set(outer.getnames()) == {'INDEX.json', *(n+'.age' for n in originals)}, 'CI_BUNDLE_MEMBERS')
        index = json.load(outer.extractfile('INDEX.json'))
        for name, folder in originals.items():
            ciphertext = outer.extractfile(name+'.age').read()
            need(hashlib.sha256(ciphertext).hexdigest() == index['components'][name]['sha256'],
                 'CI_CIPHERTEXT_DIGEST')
            plain = c.run('CI_SYNTHETIC_DECRYPT',['age','--decrypt','-i',identity],data=ciphertext,seconds=120)
            with tarfile.open(fileobj=io.BytesIO(plain),mode='r:') as inner:
                need(set(inner.getnames()) == {p.name for p in folder.iterdir()}, 'CI_PLAINTEXT_MEMBERS')
                for member in inner.getmembers():
                    need(member.isfile() and hashlib.sha256(inner.extractfile(member).read()).hexdigest() ==
                         digest(folder/member.name), 'CI_DECRYPTED_CONTENT_CHANGED')
    need(all((source/p).read_bytes() == raw for p,raw in raw_sources.items()), 'CI_PROTECTION_SOURCE_CHANGED')
    need(not any((operations/plan['run_id']).glob('*.partial')) and
         not any((operations/plan['run_id']).glob('*-documents.tar')), 'CI_PLAINTEXT_RESIDUAL')
    return {'r29ErrorReproduced':True,'exactM1AndM2SourceSchemaVerified':True,'realAgeVersion':'v1.3.2',
            'generatedSchema48SetProtected':True,'allThreeComponentsDecryptedAndCompared':True,
            'canonicalSourcesUnchanged':True,'productionKeysUsed':False,'productionConnected':False}
