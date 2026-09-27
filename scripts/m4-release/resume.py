"""Generate one new continuation, bound to the completed R34 backup and runtime."""
from pathlib import Path
import re
from generate import render, change, SOURCE, SOURCE_TREE, CANDIDATE, CANDIDATE_TREE
RUN = '288ac9d2bd274736b58da1be22186acd'
RUNTIME_NAME = 'release-'+CANDIDATE[:12]+'-m4-'+RUN

HERE = Path(__file__).resolve().parent


def render_resume(run_id):
    if run_id == RUN: raise ValueError('CONSUMED_RUN_DENIED')
    result = render(run_id)
    result['completed_backup.py'] = (HERE/'completed_backup.py').read_bytes()
    runtime = 'release-'+CANDIDATE[:12]+'-m4-'+run_id
    for name in ('backup48_after.py', 'observe48_after.py'):
        result[name] = change(result[name].decode(), runtime, RUNTIME_NAME).encode()

    remote = result['remote_release.py'].decode()
    remote = change(remote,'from image_binding import complete_binding',
                    'from completed_backup import RUN as BACKUP_RUN, RUNTIME_NAME, reconcile\nfrom image_binding import complete_binding')
    remote = change(remote,'self.backup_run_id = self.run_id', 'self.backup_run_id = BACKUP_RUN')
    remote = change(remote,"self.runtime = BASE / ('release-' + M2[:12] + '-m4-' + self.run_id)",
                    'self.runtime = BASE / RUNTIME_NAME')
    remote = change(remote,'return self.t, M1, M1_TREE, self.run_id','return self.t, M1, M1_TREE, self.backup_run_id')
    remote = change(remote,'        before = self.observer()\n        need(before[',
                    "        proof = reconcile(remote=True)\n        before = self.observer()\n        need(before['liveSessions'] == 0, 'BACKUP_REUSE_NEW_SESSION')\n        need(before[")
    start = remote.index("        self.c.docker('LOAD_QUALIFIED_M2_IMAGES'")
    end = remote.index("        need(self.c.run('RUNTIME_IDENTITY'", start)
    remote = remote[:start]+"""        images = verify_images(self.c, archive, binding)
        private(self.runtime, directory=True)
"""+remote[end:]
    remote = change(remote,"        exclusive(self.runtime/'.env.production', config.read_bytes())\n",'')
    remote = change(remote,"'imageLoadPerformed':True", "'imageLoadPerformed':False,'completedBackupAdopted':True,'diagnosis':proof['diagnosis']")
    remote = change(remote,"    def backup(self):\n        return self.make_backup('before')",
        """    def backup(self):
        proof = reconcile(remote=True)
        self.require_config_binding()
        observed = self.observer()
        need(observed['liveSessions'] == observed['otherActiveDbSessions'] == 0, 'BACKUP_REUSE_WRITERS')
        return {'receipt':proof['backupReceipt'], 'freshObservation':observed,
                'adoptedFromRunId':BACKUP_RUN, 'newBackupExecuted':False,
                'historicalReceiptSha256':proof['backupReceiptSha256']}
""".rstrip())
    remote = change(remote,"    def make_backup(self, role):\n",
                    "    def make_backup(self, role):\n        need(role == 'after', 'CONSUMED_BACKUP_REPLAY_DENIED')\n")
    remote = remote.replace("BASE/('evidence-backup48-'+self.run_id)", "BASE/('evidence-backup48-'+self.backup_run_id)")
    result['remote_release.py'] = remote.encode()

    owner = result['owner_release.py'].decode()
    owner = change(owner,'from download_images import acquire','from completed_backup import reconcile, image_reference')
    owner = change(owner,"        for name in [*manifest['files'],'package.json','release-images.tar.gz']:",
                   "        for name in [*manifest['files'],'package.json']:")
    owner = change(owner,"        image=acquire(ROOT,manifest)", "        reconcile()\n        image=image_reference()")
    owner = change(owner,'Verifica immagini M4; riuso del file locale se presente.',
                   'Riuso delle immagini verificate; nessun download e nessun nuovo trasferimento immagini.')
    owner = change(owner,'Trasferimento del pacchetto verificato; massimo 10 minuti.',
                   'Trasferimento del solo pacchetto di ripresa e diagnosi mirata; massimo 10 minuti.')
    owner = change(owner,'Backup corrente48; revoca con audit delle sessioni e riavvio controllato.',
                   'Riuso del backup48 riuscito; cifratura e copie C:/F:, senza nuovo backup iniziale.')
    result['owner_release.py'] = owner.encode()

    receiver = result['receive_package.py'].decode()
    receiver = change(receiver,"set(manifest['files']) | {'package.json', 'release-images.tar.gz'}",
                      "set(manifest['files']) | {'package.json'}")
    receiver = change(receiver,"    print(json.dumps(", """    sys.path.insert(0, str(root))
    from completed_backup import receive_prepared
    receive_prepared(root)
    print(json.dumps(""")
    receiver = change(receiver,"'imagesReusedFromConsumedPreparation': False, 'imageBytesTransferred': binding['image']['bytes'],",
                      "'imagesReusedFromConsumedPreparation': True, 'imageBytesTransferred': 0,")
    result['receive_package.py'] = receiver.encode()
    for name, raw in result.items():
        if name.endswith('.py'): compile(raw, name, 'exec')
    return result
