import assert from 'node:assert/strict';
import test from 'node:test';
import {legacyRoleProfilePolicy} from '../src/lib/admin-role-profile-legacy-policy';
import {effectiveRoleProfileOverrides,validateHistoricalRoleProfile,roleProfileOrigin} from '../src/lib/admin-role-profile-compatibility';
import {originalRoleProfile,roleProfileDigest,type RoleProfileSnapshot} from '../src/lib/admin-role-profile-contract';
import {hasPermission} from '../src/lib/permission-evaluator';
test('a valid historical technical preset remains verifiable but cannot grant now-protected permissions',()=>{
 for(const role of ['consulente','backoffice'] as const){
  const old:RoleProfileSnapshot={id:role,revision:1,catalogueHash:legacyRoleProfilePolicy[role].catalogueHash,overrides:[{permission:'user.read',allowed:true}]};
  const hash=roleProfileDigest(old);
  assert.equal(validateHistoricalRoleProfile(old),old);
  assert.deepEqual(effectiveRoleProfileOverrides(role,old.overrides),[]);
  assert.equal(hasPermission({role,active:true,permissionOverrides:old.overrides},'user.read'),false);
  assert.equal(roleProfileDigest(old),hash);
 }
});
test('only the exact known legacy catalogue can anchor history; no arbitrary profile hash is trusted',()=>{
 const role='consulente',old={...originalRoleProfile(role),catalogueHash:legacyRoleProfilePolicy[role].catalogueHash};
 assert.deepEqual(roleProfileOrigin(old,role),old);
 assert.throws(()=>validateHistoricalRoleProfile({...old,catalogueHash:'0'.repeat(64)}),/INTEGRITY/);
 assert.throws(()=>roleProfileOrigin({...old,revision:1},role),/INTEGRITY/);
 assert.throws(()=>validateHistoricalRoleProfile({...old,overrides:[{permission:'payment.read',allowed:true}]}),/INTEGRITY/);
});
