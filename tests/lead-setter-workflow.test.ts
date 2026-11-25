import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSetterCommand, effectiveSetterContact, type SetterDetails } from '../src/lib/lead-setter-contract';
import { romeWorkDay } from '../src/lib/lead-work-queues';
import { ordinaryActionAllowed, ordinaryWindowEnabled } from '../src/lib/admin-ordinary-policy';

const emptyRisk = { origin: 'UNKNOWN', finding: '', source: '', date: '' } as const;
const details: SetterDetails = {
  project: '', site: '', obstacle: '', expenses: '', timing: '', quotes: '', investment: '', ownFunds: '',
  financing: '', instalments: '', activity: '', otherAid: '', consultantSummary: 'Sintesi per il consulente.',
  assistance: 'UNKNOWN', crif: emptyRisk, central: emptyRisk, delays: emptyRisk,
};
const attempt = { id: '83964a83-1343-43db-a96c-25078d4662d6', leadId: 'synthetic', version: 1,
  leadVersion: '2026-01-01T00:01:00.000Z', outcome: 'UNREACHABLE', nextKind: 'CALLBACK', nextLocal: '2026-11-25', details: null };

test('Giornata di Roma: mezzanotte locale, cambio di data UTC, giornate di 23 e 25 ore', () => {
  const day = romeWorkDay(new Date('2026-11-24T23:00:01Z'));
  assert.equal(day.gte.toISOString(), '2026-11-24T23:00:00.000Z');
  assert.equal(day.lt.toISOString(), '2026-11-25T23:00:00.000Z');
  for (const [date, hours] of [['2026-03-29',23],['2026-10-25',25]] as const) {
    const { gte, lt } = romeWorkDay(new Date(date + 'T12:00:00Z'));
    assert.equal((+lt - +gte) / 3600000, hours);
  }
});
test('Tentativo essenziale, data valida e primo contatto effettivo distinto', () => {
  assert.equal(prepareSetterCommand(attempt).nextAt?.toISOString(),'2026-11-24T23:00:00.000Z');
  for (const patch of [{details}, {nextLocal:''}, {nextLocal:'2026-02-31'}, {nextKind:'NONE'}])
    assert.throws(() => prepareSetterCommand({...attempt,...patch}));
  assert.equal(effectiveSetterContact('UNREACHABLE'), false);
  assert.equal(effectiveSetterContact('VIDEO_ABSENT'), false);
  assert.equal(effectiveSetterContact('CONTACT'), true);
});
test('Video richiede ora univoca a Roma; un contatto e una verifica creditizia conservano la fonte', () => {
  const booking = {...attempt, outcome:'VIDEO_BOOKED', nextKind:'VIDEO', nextLocal:'2026-12-02T14:00',details};
  assert.equal(prepareSetterCommand(booking).nextAt?.toISOString(),'2026-12-02T13:00:00.000Z');
  for (const nextLocal of ['2026-12-02','2026-10-25T02:30','2026-03-29T02:30'])
    assert.throws(() => prepareSetterCommand({...booking,nextLocal}));
  const contact = {...attempt,outcome:'CONTACT',details};
  assert.throws(() => prepareSetterCommand({...contact,details:{...details,consultantSummary:''}}));
  const evidence = { origin:'VERIFIED', finding:'Dato sintetico', source:'', date:'' };
  assert.throws(() => prepareSetterCommand({...contact,details:{...details,crif:evidence}}));
  const source = 'Riscontro sintetico del consulente';
  assert.equal(prepareSetterCommand({...contact,details:{...details,crif:{...evidence,source}}}).value.details?.crif.source,source);
  assert.equal(prepareSetterCommand({...contact,details:{...details,crif:{...evidence,origin:'DECLARED'}}}).value.details?.crif.origin,'DECLARED');
});
test('Conferma estesa solo su attivazione esplicita e solo per tre comandi nominativi', () => {
  assert.equal(ordinaryWindowEnabled('disabled'),false);
  assert.equal(ordinaryWindowEnabled('enabled'),true);
  for (const action of ['N14_LEAD_INBOX_ASSIGN','N14_LEAD_INBOX_UNASSIGN','R05_ORDINARY_ASSIGNMENT']) assert.equal(ordinaryActionAllowed(action),true);
  for (const action of ['R05_RESPONSIBILITY','USER_PERMISSION_OVERRIDE','USER_ROLE_UPDATE','DRIVE_FOLDER_MANAGE',
    'PAYMENT_COLLECTION_DECLARE','LEAD_LIFECYCLE','ORDINARY_EMAIL_CONFIRM_SEND','unknown']) assert.equal(ordinaryActionAllowed(action),false);
});
