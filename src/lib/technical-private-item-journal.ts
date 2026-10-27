import { z } from 'zod';
import { canonicalJson, canonicalSha256 } from './canonical-json';
import type { PrivilegedStepUpKey } from './privileged-step-up-token';
import { admitsTechnicalPrivateItemCreation, technicalPrivateItemAdmission, technicalPrivateItemCommand,
  technicalPrivateItemOrigin, technicalPrivateItemRequestDigest,
  type TechnicalPrivateItemAdmission, type TechnicalPrivateItemCommand } from './technical-private-item-contract';
import { confirmTechnicalPrivateItemCreation, readTechnicalPrivateItemOriginProof, readTechnicalPrivateItemReceipt,
  signTechnicalPrivateItemOrigin, signTechnicalPrivateItemReceipt, technicalPrivateItemReceipt } from './technical-private-item-proof';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const technicalPrivateItemRecord = z.object({ command: technicalPrivateItemCommand,
  admission: technicalPrivateItemAdmission, origin: technicalPrivateItemOrigin, originProof: hash,
  receipt: technicalPrivateItemReceipt, receiptProof: hash }).strict();
export type TechnicalPrivateItemRecord = z.infer<typeof technicalPrivateItemRecord>;

export function prepareTechnicalPrivateItemRecord(key: PrivilegedStepUpKey, raw: TechnicalPrivateItemCommand,
  admission: TechnicalPrivateItemAdmission, token: string, confirmed: boolean, now: Date): TechnicalPrivateItemRecord | null {
  const plan = confirmTechnicalPrivateItemCreation(key, raw, admission, token, confirmed, now.getTime());
  if (!plan) return null;
  const c = plan.command, a = technicalPrivateItemAdmission.parse(admission), recordedAt = now.toISOString();
  const origin = technicalPrivateItemOrigin.parse({ protocol: 'TECHNICAL_PRIVATE_ITEM_ORIGIN_V1', commandId: c.commandId,
    itemId: c.itemId, kind: c.kind, target: c.target, ...a.parent, actorId: a.actorId, createdAt: recordedAt });
  const receipt = technicalPrivateItemReceipt.parse({ protocol: 'TECHNICAL_PRIVATE_ITEM_RECEIPT_V1',
    commandId: c.commandId, itemId: c.itemId, kind: c.kind, target: c.target, actorId: a.actorId,
    sessionId: a.sessionId, authorityRevision: a.authorityRevision, keyVersion: key.version,
    requestDigest: plan.requestDigest, admissionSha256: canonicalSha256(a), recordedAt,
    grantCreated: false, notificationCreated: false });
  return { command: c, admission: a, origin, originProof: signTechnicalPrivateItemOrigin(key, origin),
    receipt, receiptProof: signTechnicalPrivateItemReceipt(key, receipt) };
}

/** Integrity of a retained command, not current authority or a recipient grant.
 * Later expiry does not erase its receipt. Current admission is checked by the
 * service before any recovery result is projected. */
export function readTechnicalPrivateItemRecord(key: PrivilegedStepUpKey, raw: unknown, now: Date) {
  try {
    const saved = technicalPrivateItemRecord.parse(raw), { command: c, admission: a, origin: o, receipt: r } = saved;
    if (canonicalJson(saved) !== canonicalJson(raw) || !Number.isFinite(now.getTime())
      || !admitsTechnicalPrivateItemCreation(c, a, Date.parse(r.recordedAt))
      || r.authorityRevision !== a.authorityRevision || r.admissionSha256 !== canonicalSha256(a)
      || !readTechnicalPrivateItemReceipt(key, r, saved.receiptProof, { commandId: c.commandId,
        itemId: c.itemId, kind: c.kind, target: c.target, actorId: a.actorId, sessionId: a.sessionId,
        requestDigest: technicalPrivateItemRequestDigest(c) }, now.getTime())
      || !readTechnicalPrivateItemOriginProof(key, o, saved.originProof, c)
      || canonicalJson(o) !== canonicalJson({ protocol: 'TECHNICAL_PRIVATE_ITEM_ORIGIN_V1', commandId: c.commandId,
        itemId: c.itemId, kind: c.kind, target: c.target, ...a.parent, actorId: a.actorId, createdAt: r.recordedAt })) return null;
    return saved;
  } catch { return null; }
}
