"""Exact M3 software return qualification; never a production recovery claim."""
from pathlib import Path
from common import digest, load, need
from sealed_programs import M2, M2_TREE


def details(binding, path=None):
    path = path or Path(__file__).resolve().with_name('qualification.json')
    proof = load(path)
    r = proof['receipt']
    need(proof['run'] == 36281830361 and proof['job'] == 108515008313 and proof['artifactId'] == 10919540739
         and proof['artifactZipSha256'] == 'ef93641bd6ddc0f98ca34f8c2f642c972f44cede166d086beb5ca4d8ed5eee9e'
         and r['status'] == 'CI_SCHEMA48_M1_APPLICATION_RETURN_PASS' and r['schema'] == 48
         and r['synthetic'] is True and r['productionAdmitted'] is False and r['databaseRestoreQualified'] is False,
         'RETURN_QUALIFICATION_SCOPE')
    for actual,expected in ((r['candidateCommit'],M2),(r['candidateTree'],M2_TREE),
        (r['candidateCommit'],binding['candidate']),(r['candidateTree'],binding['candidateTree']),
        (r['candidateImageId'],binding['candidateCiImage']),(r['recoveryCommit'],binding['returnCommit']),
        (r['recoveryTree'],binding['returnTree']),(r['recoveryImageId'],binding['returnCiImage']),
        (r['imageArchiveSha256'],binding['imageArchiveSha256'])):
        need(actual == expected,'RETURN_QUALIFICATION_IDENTITY')
    evidence = {'source':proof,'sourceSha256':digest(path),'archiveBindingRequired':True,'productionRecoveryClaimed':False}
    return {'softwareEvidence':evidence,'returnCompatibilityEvidence':evidence|{'schema':48}}


def validate(review,binding):
    for key,expected in details(binding).items():
        need(type(review.get(key)) is dict and review[key] == expected,'QUALIFICATION_EVIDENCE_REQUIRED',field=key)
    return True
