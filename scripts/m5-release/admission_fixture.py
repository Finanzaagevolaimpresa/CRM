"""Synthetic environment boundary for the real generated dispatcher/models/forward gates."""
import contextlib
import copy
import importlib.util
import io
import json
import hashlib
import os
from pathlib import Path
import sys
import types
from unittest.mock import patch

def program(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

class ForwardBoundary(Exception):pass

def exercise(helpers,root,binding,ledger_rows,*,model_drift=False):
    helpers,root=Path(helpers),Path(root)
    root.mkdir(mode=0o700)
    common=program(helpers/'common.py','m5_dispatch_common')
    remote=program(helpers/'remote_release.py','m5_dispatch_remote')
    evidence=program(helpers/'release_evidence.py','m5_dispatch_evidence')
    c=common
    run='a'*32
    r=remote.Release.__new__(remote.Release)
    r.root=helpers
    r.work=root/'work';r.work.mkdir(mode=0o700)
    r.runtime=root/'runtime';r.runtime.mkdir(mode=0o700)
    r.run_id=r.backup_run_id=run
    r.b=binding
    r.t={'appId':'a'*64,'appImage':'sha256:'+'b'*64}
    r.manifest={'migrations':[],'authorityReference':'https://example.invalid/ci-only','deltaSha256':'d'*64}
    r.review={'reference':'https://example.invalid/ci-review',**evidence.details(binding,helpers/'qualification.json')}
    r.stages=c.Stages(r.work,run)
    for stage,deps in (('backup',[]),('copies-backup',['backup']),('recover',['copies-backup'])):
        r.stages.begin(stage,deps)
        r.stages.complete(stage,{'scope':'SYNTHETIC_PREDECESSOR_FIXTURE'})
    r.require_config_binding=lambda:None
    def rows(expected):
        actual=ledger_rows()
        remote.ledger_valid(actual,expected)
        return actual
    r.rows=rows
    r.observer=lambda:{'ledgerCount':len(rows(binding['ledger49'])),'zeroIncomplete':True,
                       'liveSessions':0,'otherActiveDbSessions':0}
    def forbidden(*_,**__):raise AssertionError('COMMAND_OUTSIDE_SYNTHETIC_BOUNDARY')
    r.c=types.SimpleNamespace(cwd=None,run=forbidden,docker=forbidden)
    baseline={'engine':{'kind':'docker','host':'unix:///var/run/docker.sock','id':'synthetic','name':'synthetic','os_type':'linux'},
        'app':{'id':r.t['appId'],'created':'synthetic-app','image_id':r.t['appImage']},
        'postgres':{'id':'c'*64,'image':'sha256:'+'d'*64,'created':'synthetic-postgres'},
        'resources':{'volumes':{x:{'Name':x,'Driver':'local','Mountpoint':'/var/'+x,'CreatedAt':'synthetic',
            'Labels':None,'Options':None,'Scope':'local'} for x in ('crm_documents','postgres_data')},
            'network':{'Id':'f'*64,'Name':'fai-crm_default','Created':'synthetic','Driver':'bridge','Scope':'local',
                'Labels':{},'Options':{},'IPAM':{},'Internal':False,'Attachable':False,'Ingress':False}}}
    backup=root/('evidence-backup49-'+run);backup.mkdir(mode=0o700)
    config=backup/'configuration';config.mkdir(mode=0o700)
    prior={'services':{'app':{'image':r.t['appImage'],'environment':{'SYNTHETIC_ONLY':'true'}},
                       'postgres':{'image':baseline['postgres']['image']}}}
    c.exclusive(backup/'BASELINE.json',baseline)
    c.exclusive(config/'frozen-source.json',prior)
    calls=[]
    class EnvironmentModels:
        def __init__(self,*args):pass
        def model(self,image,deadline):
            calls.append('model')
            value=copy.deepcopy(prior)
            value['services']['app']['image']=image
            if model_drift:value['services']['app']['environment']['UNAUTHORIZED_CHANGE']='true'
            return value
        def snapshot(self,deadline):
            calls.append('snapshot')
            return {'resources':baseline['resources'],'postgres':baseline['postgres'],'postgres_healthy':True,
                    'foreign_containers':[],'migrators':[],'app':baseline['app']|{'state':'healthy'}}
    expected_files=['models.json',*[f'frozen-{role}.json' for role in ('previous','candidate','return')]]
    assert not any((r.work/name).exists() for name in expected_files)
    assert not hasattr(r,'receipt')
    with contextlib.ExitStack() as stack:
        if os.name=='nt':stack.enter_context(patch.dict(sys.modules,{'fcntl':types.ModuleType('fcntl')}))
        repo=Path(__file__).resolve().parents[2]
        canonical=repo/'scripts/n05/failed_app_return.py'
        from generate import source
        raw=source('scripts/n05/failed_app_return.py',binding['candidate'])
        assert hashlib.sha256(raw).hexdigest()==binding['canonicalPrograms']['scripts/n05/failed_app_return.py']
        n05=types.ModuleType('m5_dispatch_n05');n05.__file__=str(canonical)
        exec(compile(raw,str(canonical),'exec'),n05.__dict__)
        if os.name=='nt':stack.enter_context(patch.object(n05,'private_file',side_effect=c.private))
        stack.enter_context(patch.object(n05,'DockerEngine',EnvironmentModels))
        r.n05=lambda:n05
        stack.enter_context(patch.object(remote,'BASE',root))
        stack.enter_context(patch.dict(r.deploy.__globals__,{'BASE':root}))
        stack.enter_context(patch.object(remote,'Release',return_value=r))
        stack.enter_context(patch.object(remote.os,'umask',return_value=0o077))
        def dispatch(stage):
            cli=types.SimpleNamespace(argv=['remote_release.py',stage],stdin=types.SimpleNamespace(buffer=io.BytesIO(b'{}')))
            stream=io.StringIO()
            with patch.object(remote,'sys',cli),contextlib.redirect_stdout(stream):
                remote.main()
            return json.loads(stream.getvalue())
        if model_drift:
            try:dispatch('migrate')
            except Exception:
                assert (r.work/'migrate.intent.json').exists() and not (r.work/'migrate.json').exists()
                assert not (r.work/'models.json').exists()
                raise
            raise AssertionError('MODEL_DRIFT_ACCEPTED')
        before=ledger_rows()
        result=dispatch('migrate')
        assert result==c.load(r.work/'migrate.json')==r.stages.result('migrate')
        assert result['protocol']=='FAI_M5_ASSISTED_STAGE_R36' and result['status']=='PASS'
        assert result['before']==result['after']==49 and result['migrator'] is None and result['newMigrations']==[]
        assert result['modelsSha256']==c.digest(r.work/'models.json') and ledger_rows()==before
        plan=c.load(r.work/'models.json')
        assert set(plan['configs'])=={'previous','candidate','return'} and all((r.work/n).exists() for n in expected_files)
        for ref in plan['configs'].values():n05.validate_ref(ref,ref['kind'])
        saved={name:c.digest(r.work/name) for name in [*expected_files,'migrate.json','migrate.intent.json']}
        try:dispatch('migrate')
        except c.Stop as exc:assert exc.code=='STAGE_CONSUMED_RECONCILE_ONLY'
        else:raise AssertionError('MIGRATE_STAGE_REPLAYED')
        assert saved=={name:c.digest(r.work/name) for name in saved}
        forward=[]
        def boundary(tool,operation,path):
            assert operation=='forward'
            plan=c.load(path)
            tool.validate_plan(plan)
            for ref in [*plan['gates'].values(),plan['compatibility']]:
                tool.validate_evidence(ref,plan,tool.evidence_binding(plan))
            forward.append(operation)
            raise ForwardBoundary()
        r.canonical_transition=boundary
        try:dispatch('deploy')
        except ForwardBoundary:pass
        else:raise AssertionError('FORWARD_BOUNDARY_NOT_REACHED')
        assert forward==['forward'] and calls==['model','model','snapshot']
        assert not (r.work/'forward.json').exists() and not (r.work/'deploy.json').exists()
        assert ledger_rows()==before
    return result|{'dispatcherUsed':True,'durableReceiptReadBack':True,'repeatDenied':True,
        'modelsGeneratedAndValidated':True,'canonicalForwardPlanValidated':True,
        'forwardExecuted':False,'modelObservationSource':'SYNTHETIC_DOCKER_BOUNDARY'}
