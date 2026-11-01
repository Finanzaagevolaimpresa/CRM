"use server";
import { assertTechnicalServerAction } from '@/lib/technical-surface-guards';
import { redirect } from "next/navigation";
import { requirePermission } from "./auth";
import { prisma } from "./prisma";
import {
  attestPracticeMaterialsComplete,
  confirmPracticeFunding,
  createPracticeReadiness,
  decidePracticeMaterial,
  formalizePractice,
  linkPracticeClientService,
  PracticeReadinessError,
  proposePracticeOfferRevision,
  recordPracticeFunding,
  reversePracticeFunding,
  startPractice,
} from "./practice-readiness";

async function run(
  form: FormData,
  fn: (
    db: typeof prisma,
    actor: Awaited<ReturnType<typeof requirePermission>>,
    raw: unknown,
  ) => Promise<{ id?: string; practiceId?: string }>,
) {
  const actor = await requirePermission("service.write");
  let result: { id?: string; practiceId?: string };
  try {
    result = await fn(prisma, actor, Object.fromEntries(form.entries()));
  } catch (error) {
    if (!(error instanceof PracticeReadinessError)) throw error;
    const query = new URLSearchParams({ error: error.code });
    for (const field of [
      "practiceId",
      "reference",
      "amount",
      "commercialOfferSelection",
      "controlledIntakeId",
      "serviceRevisionId",
      "clientId",
      "projectId",
      "digitalProjectType",
      "scope",
      "startupConditions",
      "requiredInitialAmount",
      "contractId",
      "signedDocumentId",
      "signedDocumentVersionId",
      "clientServiceId",
    ]) {
      const value = form.get(field);
      if (typeof value === "string") query.set(field, value.slice(0, 120));
    }
    redirect(`/practice-readiness?${query}`);
  }
  redirect(`/practice-readiness?updated=${result.id ?? result.practiceId}`);
}
export async function proposePracticeOfferRevisionAction(form: FormData) {
  await assertTechnicalServerAction("practice-readiness-actions:proposePracticeOfferRevisionAction");
  const selection = String(form.get("commercialOfferSelection") ?? "");
  const separator = selection.lastIndexOf("|");
  if (separator > 0) {
    form.set("commercialOfferId", selection.slice(0, separator));
    form.set("expectedOfferUpdatedAt", selection.slice(separator + 1));
  }
  return run(form, proposePracticeOfferRevision);
}
export async function createPracticeReadinessAction(form: FormData) {
  await assertTechnicalServerAction("practice-readiness-actions:createPracticeReadinessAction");
  return run(form, createPracticeReadiness);
}
export async function formalizePracticeAction(form: FormData) {
  await assertTechnicalServerAction("practice-readiness-actions:formalizePracticeAction");
  return run(form, formalizePractice);
}
export async function linkPracticeClientServiceAction(form: FormData) {
  await assertTechnicalServerAction("practice-readiness-actions:linkPracticeClientServiceAction");
  return run(form, linkPracticeClientService);
}
export async function recordPracticeFundingAction(form: FormData) {
  await assertTechnicalServerAction("practice-readiness-actions:recordPracticeFundingAction");
  return run(form, recordPracticeFunding);
}
export async function confirmPracticeFundingAction(form: FormData) {
  await assertTechnicalServerAction("practice-readiness-actions:confirmPracticeFundingAction");
  return run(form, confirmPracticeFunding);
}
export async function reversePracticeFundingAction(form: FormData) {
  await assertTechnicalServerAction("practice-readiness-actions:reversePracticeFundingAction");
  return run(form, reversePracticeFunding);
}
export async function decidePracticeMaterialAction(form: FormData) {
  await assertTechnicalServerAction("practice-readiness-actions:decidePracticeMaterialAction");
  return run(form, decidePracticeMaterial);
}
export async function attestPracticeMaterialsCompleteAction(form: FormData) {
  await assertTechnicalServerAction("practice-readiness-actions:attestPracticeMaterialsCompleteAction");
  return run(form, attestPracticeMaterialsComplete);
}
export async function startPracticeAction(form: FormData) {
  await assertTechnicalServerAction("practice-readiness-actions:startPracticeAction");
  return run(form, startPractice);
}
