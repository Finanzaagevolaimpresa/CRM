"use server";
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
  const selection = String(form.get("commercialOfferSelection") ?? "");
  const separator = selection.lastIndexOf("|");
  if (separator > 0) {
    form.set("commercialOfferId", selection.slice(0, separator));
    form.set("expectedOfferUpdatedAt", selection.slice(separator + 1));
  }
  return run(form, proposePracticeOfferRevision);
}
export async function createPracticeReadinessAction(form: FormData) {
  return run(form, createPracticeReadiness);
}
export async function formalizePracticeAction(form: FormData) {
  return run(form, formalizePractice);
}
export async function linkPracticeClientServiceAction(form: FormData) {
  return run(form, linkPracticeClientService);
}
export async function recordPracticeFundingAction(form: FormData) {
  return run(form, recordPracticeFunding);
}
export async function confirmPracticeFundingAction(form: FormData) {
  return run(form, confirmPracticeFunding);
}
export async function reversePracticeFundingAction(form: FormData) {
  return run(form, reversePracticeFunding);
}
export async function decidePracticeMaterialAction(form: FormData) {
  return run(form, decidePracticeMaterial);
}
export async function attestPracticeMaterialsCompleteAction(form: FormData) {
  return run(form, attestPracticeMaterialsComplete);
}
export async function startPracticeAction(form: FormData) {
  return run(form, startPractice);
}
