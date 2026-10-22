import assert from 'node:assert/strict';
import test from 'node:test';
import { technicalAssignmentContext, type TechnicalContextSnapshot } from '../src/lib/technical-assignment-context';
import { admitsTechnicalAssignmentManager, admitsTechnicalRolePermission } from '../src/lib/technical-assignment-permissions';
import type { PermissionSession } from '../src/lib/permission-evaluator';

const base:TechnicalContextSnapshot = {
  kind:'TechnicalPractice',targetId:'practice_a',
  client:{id:'client_a',recordUpdateEpoch:2,deletedAt:null,salesOwnerId:'sales_a',consultantId:null},
  project:{id:'project_a',recordUpdateEpoch:3,deletedAt:null,clientId:'client_a',consultantId:'tech_a',status:'in_lavorazione'},
  service:{id:'service_a',recordUpdateEpoch:4,deletedAt:null,clientId:'client_a',projectId:'project_a',assignedToId:'tech_a',status:'attivo'},
  practice:{id:'practice_a',recordUpdateEpoch:5,deletedAt:null,clientId:'client_a',projectId:'project_a',clientServiceId:'service_a',commercialOwnerId:'sales_a',technicalOwnerId:'tech_a',status:'da_progettare'},
};
const actor:PermissionSession = {role:'consulente',active:true,permissionOverrides:[]};

test('technical work has exact canonical parents but exposes no dossier or owner data in its context result', () => {
  const context=technicalAssignmentContext(base);
  assert.ok(context);
  assert.deepEqual(Object.keys(context).sort(),['clientId','clientServiceId','contextSha256','kind','projectId','targetId']);
  assert.equal(context.targetId,'practice_a');
  const project=technicalAssignmentContext({...base,kind:'Project',targetId:'project_a',service:null,practice:null});
  assert.ok(project);
  assert.notEqual(project.contextSha256,context.contextSha256);
});
test('missing, mismatched, retired and unexpected parents fail closed', () => {
  const changes=[
    {...base,client:null}, {...base,project:null}, {...base,service:null},
    {...base,client:{...base.client!,id:'client_b'}},
    {...base,project:{...base.project!,clientId:'client_b'}},
    {...base,service:{...base.service!,projectId:'project_b'}},
    {...base,practice:{...base.practice!,clientServiceId:null}},
    {...base,practice:{...base.practice!,id:'practice_b'}},
    {...base,client:{...base.client!,deletedAt:new Date()}},
    {...base,project:{...base.project!,status:'archiviato'}},
    {...base,service:{...base.service!,status:'sospeso'}},
    {...base,practice:{...base.practice!,status:'archiviata'}},
    {...base,kind:'Project',targetId:'project_a'},
  ];
  for(const row of changes) assert.equal(technicalAssignmentContext(row),null,JSON.stringify(row));
});
test('service-only project relation is reconciled without admitting a sibling practice', () => {
  const linked={...base,practice:{...base.practice!,projectId:null}};
  assert.ok(technicalAssignmentContext(linked));
  assert.equal(technicalAssignmentContext({...linked,project:{...base.project!,id:'project_b'}}),null);
  const unlinked={...base,project:null,service:null,practice:{...base.practice!,projectId:null,clientServiceId:null}};
  assert.ok(technicalAssignmentContext(unlinked));
  assert.equal(technicalAssignmentContext({...unlinked,project:base.project}),null);
});
test('owner changes and A-to-B-to-A generations invalidate signed assignment context', () => {
  const current=technicalAssignmentContext(base)!;
  for(const key of ['client','project','service','practice'] as const) {
    const changed={...base,[key]:{...base[key]!,recordUpdateEpoch:base[key]!.recordUpdateEpoch+2}};
    assert.notEqual(technicalAssignmentContext(changed)?.contextSha256,current.contextSha256,key);
  }
  assert.notEqual(technicalAssignmentContext({...base,client:{...base.client!,salesOwnerId:'sales_b'}})?.contextSha256,current.contextSha256);
  assert.notEqual(technicalAssignmentContext({...base,practice:{...base.practice!,technicalOwnerId:'tech_b'}})?.contextSha256,current.contextSha256);
});
test('ordinary progress does not implicitly erase a valid assignment, while unknown inputs are rejected', () => {
  const current=technicalAssignmentContext(base)!;
  assert.equal(technicalAssignmentContext({...base,practice:{...base.practice!,status:'in_lavorazione'}})?.contextSha256,current.contextSha256);
  for(const extra of [{approved:true},{role:'admin'},{contract:'private'}]) assert.equal(technicalAssignmentContext({...base,...extra}),null);
  assert.equal(technicalAssignmentContext({...base,client:{...base.client!,recordUpdateEpoch:0}}),null);
});
test('two technicians may work without parent-list permission; permissions alone never prove a grant', () => {
  for(const role of ['consulente','backoffice'] as const) {
    const current={...actor,role,permissionOverrides:[{permission:'client.read',allowed:false},{permission:'service.read',allowed:false}]};
    assert.equal(admitsTechnicalRolePermission(current,'TechnicalPractice','update_fields'),true);
    assert.equal(admitsTechnicalRolePermission(current,'TechnicalPractice','request_admin'),true);
  }
  for(const role of ['commerciale','collaboratore_limitato','admin','amministrazione'] as const)
    assert.equal(admitsTechnicalRolePermission({...actor,role},'TechnicalPractice'),false);
});
test('current action-specific revocation and inactive accounts deny operational work', () => {
  const actions=['update_fields','update_status','manage_checklist','manage_deadlines','request_admin','upload_document'] as const;
  const permissions=['technical.write','technical.status','service.write','service.write','practice_communications.write','document.upload'];
  actions.forEach((action,index)=>{
    assert.equal(admitsTechnicalRolePermission(actor,'TechnicalPractice',action),true);
    assert.equal(admitsTechnicalRolePermission({...actor,permissionOverrides:[{permission:permissions[index],allowed:false}]},'TechnicalPractice',action),false);
  });
  assert.equal(admitsTechnicalRolePermission({...actor,active:false},'Project'),false);
  assert.equal(admitsTechnicalRolePermission({...actor,permissionOverrides:[{permission:'technical.read',allowed:false}]},'TechnicalPractice','upload_document'),false);
});
test('management role is only a ceiling; explicit Admin denials are respected', () => {
  assert.equal(admitsTechnicalAssignmentManager(actor,'TechnicalPractice'),false);
  const admin={...actor,role:'admin' as const};
  assert.equal(admitsTechnicalAssignmentManager(admin,'TechnicalPractice'),true);
  assert.equal(admitsTechnicalAssignmentManager({...admin,permissionOverrides:[{permission:'technical.assign',allowed:false}]},'TechnicalPractice'),false);
  assert.equal(admitsTechnicalAssignmentManager({...admin,permissionOverrides:[{permission:'project.write',allowed:false}]},'Project'),false);
});
