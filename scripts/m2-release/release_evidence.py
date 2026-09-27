"""Exact existing M2/schema48 CI evidence, linked to measured OCI identities.

The inner receipt remains explicitly synthetic. It proves image/schema
compatibility, never production restore, private-key access or deploy success.
"""
from pathlib import Path
from common import digest, load, need, value_sha
from sealed_programs import M2, M2_TREE

PROOF_SHA = '66dcf00894a0e9f4f1feee43c7fd8dafc0f188f9b97edbe53eed3aa123b55a41'

def details(binding, path=None):
    path = path or Path(__file__).resolve().with_name('return_qualification.json')
    need(digest(path) == PROOF_SHA, 'RETURN_QUALIFICATION_CHANGED')
    proof = load(path)
    r = proof['receipt']
    need(proof['run'] == 36276199090 and proof['job'] == 108499319514 and
         proof['artifactId'] == 10917328245 and r['status'] == 'CI_SCHEMA48_M1_APPLICATION_RETURN_PASS' and
         r['synthetic'] is True and r['schema'] == 48 and r['productionAdmitted'] is False and
         r['databaseRestoreQualified'] is False, 'RETURN_QUALIFICATION_SCOPE')
    for actual, expected in ((r['candidateCommit'],M2),(r['candidateTree'],M2_TREE),
            (r['candidateCommit'],binding['candidate']),(r['candidateTree'],binding['candidateTree']),
            (r['candidateImageId'],binding['candidateCiImage']),
            (r['recoveryCommit'],binding['returnCommit']),(r['recoveryTree'],binding['returnTree']),
            (r['recoveryImageId'],binding['returnCiImage']),
            (r['imageArchiveSha256'],binding['imageArchiveSha256'])):
        need(actual == expected, 'RETURN_QUALIFICATION_IDENTITY')
    compatibility = {'source':proof,'sourceSha256':PROOF_SHA,'schema':48,
        'candidateRuntimeImage':binding['candidateImage'],'returnRuntimeImage':binding['returnImage'],
        'archiveBindingRequired':True,'productionRecoveryClaimed':False}
    artifacts = {'run':proof['run'],'artifactId':proof['artifactId'],
        'artifactZipSha256':proof['artifactZipSha256'],'imageArchiveSha256':r['imageArchiveSha256'],
        'candidateCommit':M2,'candidateTree':M2_TREE,'candidateCiConfig':r['candidateImageId'],
        'returnCommit':r['recoveryCommit'],'returnTree':r['recoveryTree'],'returnCiConfig':r['recoveryImageId'],
        'candidateRuntimeImage':binding['candidateImage'],'returnRuntimeImage':binding['returnImage'],
        'measuredImageArchiveLinkRequired':True}
    return {'softwareEvidence':artifacts,'returnCompatibilityEvidence':compatibility}

def validate(review, binding):
    for key, expected in details(binding).items():
        need(type(review.get(key)) is dict and review[key] == expected,
             'RETURN_COMPATIBILITY_EVIDENCE_REQUIRED' if key == 'returnCompatibilityEvidence'
             else 'SOFTWARE_ARTIFACT_EVIDENCE_REQUIRED', field=key)
    return True
