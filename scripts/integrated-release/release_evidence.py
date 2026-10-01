"""Exact R40/R37 saved images. A qualified recovery is not rollback authority."""
from pathlib import Path
from common import digest, load, need
from sealed_programs import M2, M2_TREE


def details(binding, path=None):
    path = path or Path(__file__).resolve().with_name('qualification.json')
    proof = load(path)
    r = proof['receipt']
    need(proof['run'] == 36604695948 and proof['job'] == 109530619208 and proof['artifactId'] == 11050489329
         and proof['artifactHead'] == '81e532987371bbc5d7a1b07d4ab02b36349f12ac'
         and proof['artifactZipSha256'] == '6f3e1b2553f2c014c03ec2906756486b6b56b05c98e5b7f21c24a273d5fb4efd'
         and r['status'] == 'CI_SCHEMA49_R37_APPLICATION_RETURN_PASS' and r['schema'] == 49
         and r['synthetic'] is True and r['productionAdmitted'] is False and r['databaseRestoreQualified'] is False
         and r['m4HistoryPreserved'] is True and r['m4AvailableDuringReturn'] is True
         and r['r37ReturnSource'] is True and r['imagesRebuilt'] is False
         and r['recoveryCommit'] == '8e3874a304b1cb2281d59146448bcdf121afe0d1'
         and r['recoveryTree'] == '2e9fb13313a2287918d4776918d9f7df530649a1',
         'RETURN_QUALIFICATION_SCOPE')
    for actual,expected in ((r['candidateCommit'],M2),(r['candidateTree'],M2_TREE),
        (r['candidateCommit'],binding['candidate']),(r['candidateTree'],binding['candidateTree']),
        (r['candidateImageId'],binding['candidateCiImage']),(r['recoveryCommit'],binding['returnCommit']),
        (r['recoveryTree'],binding['returnTree']),(r['recoveryImageId'],binding['returnCiImage']),
        (r['imageArchiveSha256'],binding['imageArchiveSha256'])):
        need(actual == expected,'RETURN_QUALIFICATION_IDENTITY')
    evidence = {'source':proof,'sourceSha256':digest(path),'archiveBindingRequired':True,'productionRecoveryClaimed':False,'automaticReturnAuthorized':False}
    return {'softwareEvidence':evidence,'returnCompatibilityEvidence':evidence|{'schema':49}}


def validate(review,binding):
    for key,expected in details(binding).items():
        need(type(review.get(key)) is dict and review[key] == expected,'QUALIFICATION_EVIDENCE_REQUIRED',field=key)
    return True
