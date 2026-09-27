"""Immutable M5 images and M1 return on schema49; no production claim."""
from pathlib import Path
from common import digest, load, need
from sealed_programs import M2, M2_TREE


def details(binding, path=None):
    path = path or Path(__file__).resolve().with_name('qualification.json')
    proof = load(path)
    r = proof['receipt']
    need(proof['run'] == 36329143320 and proof['job'] == 108647603152 and proof['artifactId'] == 10935172794
         and proof['artifactZipSha256'] == '2234b717b815a645dc6658b2cf879d70561d820d2380c6fbea8a661da32eb1ae'
         and r['status'] == 'CI_SCHEMA49_M1_APPLICATION_RETURN_PASS' and r['schema'] == 49
         and r['synthetic'] is True and r['productionAdmitted'] is False and r['databaseRestoreQualified'] is False
         and r['m4HistoryPreserved'] is True and r['m4AvailableDuringM1Return'] is False,
         'RETURN_QUALIFICATION_SCOPE')
    for actual,expected in ((r['candidateCommit'],M2),(r['candidateTree'],M2_TREE),
        (r['candidateCommit'],binding['candidate']),(r['candidateTree'],binding['candidateTree']),
        (r['candidateImageId'],binding['candidateCiImage']),(r['recoveryCommit'],binding['returnCommit']),
        (r['recoveryTree'],binding['returnTree']),(r['recoveryImageId'],binding['returnCiImage']),
        (r['imageArchiveSha256'],binding['imageArchiveSha256'])):
        need(actual == expected,'RETURN_QUALIFICATION_IDENTITY')
    evidence = {'source':proof,'sourceSha256':digest(path),'archiveBindingRequired':True,'productionRecoveryClaimed':False}
    return {'softwareEvidence':evidence,'returnCompatibilityEvidence':evidence|{'schema':49}}


def validate(review,binding):
    for key,expected in details(binding).items():
        need(type(review.get(key)) is dict and review[key] == expected,'QUALIFICATION_EVIDENCE_REQUIRED',field=key)
    return True
