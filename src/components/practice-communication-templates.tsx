"use client";

import { useMemo, useState, useTransition } from "react";
import { PrimaryButton } from "@/components/actions";
import { Badge, EmptyState } from "@/components/ui";
import { createPracticeCommunicationDraftAndRefresh } from "@/lib/form-actions";
import type {
  PracticeCommunicationTemplate,
  PracticeCommunicationTemplateCategory,
} from "@/lib/practice-communication-templates";

const categoryTone: Record<
  PracticeCommunicationTemplateCategory,
  "blue" | "green" | "orange"
> = {
  cliente: "blue",
  commerciale: "green",
  interno: "orange",
};

const communicationTypeByCategory: Record<
  PracticeCommunicationTemplateCategory,
  "cliente" | "commerciale" | "interna"
> = {
  cliente: "cliente",
  commerciale: "commerciale",
  interno: "interna",
};

type TemplatePlaceholderContext = {
  clientName?: string | null;
  practiceName?: string | null;
  practiceStatus?: string | null;
  nextAction?: string | null;
  missingDocuments?: string[];
};

function fallback(value: string | null | undefined, fallbackValue: string) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallbackValue;
}

function compileTemplateText(
  text: string,
  context?: TemplatePlaceholderContext,
) {
  const missingDocuments =
    context?.missingDocuments
      ?.map((document) => document.trim())
      .filter(Boolean) ?? [];
  const values: Record<string, string> = {
    "[NOME_CLIENTE]": fallback(context?.clientName, "cliente"),
    "[NOME_PRATICA]": fallback(context?.practiceName, "pratica tecnica"),
    "[STATO_PRATICA]": fallback(context?.practiceStatus, "stato da verificare"),
    "[PROSSIMA_AZIONE]": fallback(context?.nextAction, "da definire"),
    "[DOCUMENTI_MANCANTI]":
      missingDocuments.length > 0
        ? missingDocuments.join(", ")
        : "documentazione da integrare",
  };

  return Object.entries(values).reduce(
    (compiled, [placeholder, value]) => compiled.replaceAll(placeholder, value),
    text,
  );
}

function compileTemplate(
  template: PracticeCommunicationTemplate,
  context?: TemplatePlaceholderContext,
) {
  return {
    title: compileTemplateText(template.suggestedTitle, context),
    text: compileTemplateText(template.suggestedText, context),
  };
}

export function PracticeCommunicationTemplates({
  templates,
  technicalPracticeId,
  canCreateDraft,
  placeholderContext,
}: {
  templates: PracticeCommunicationTemplate[];
  technicalPracticeId: string;
  canCreateDraft: boolean;
  placeholderContext?: TemplatePlaceholderContext;
}) {
  const [selectedId, setSelectedId] = useState(templates[0]?.id ?? "");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const selected = useMemo(
    () =>
      templates.find((template) => template.id === selectedId) ?? templates[0],
    [selectedId, templates],
  );
  const selectedPreview = selected
    ? compileTemplate(selected, placeholderContext)
    : null;

  async function copyText(template: PracticeCommunicationTemplate) {
    const compiled = compileTemplate(template, placeholderContext);
    await navigator.clipboard.writeText(
      `${compiled.title}\n\n${compiled.text}`,
    );
    setCopiedId(template.id);
    window.setTimeout(
      () =>
        setCopiedId((current) => (current === template.id ? null : current)),
      2200,
    );
  }

  function createDraft(template: PracticeCommunicationTemplate) {
    const compiled = compileTemplate(template, placeholderContext);
    const form = new FormData();
    form.set("technicalPracticeId", technicalPracticeId);
    form.set("type", communicationTypeByCategory[template.category]);
    form.set(
      "channel",
      template.category === "cliente" ? "email" : "nota_interna",
    );
    form.set("title", compiled.title);
    form.set("content", compiled.text);
    form.set(
      "status",
      template.category === "interno" ? "bozza" : "da_revisionare",
    );
    if (template.category !== "cliente")
      form.set(
        "internalNote",
        `Bozza generata da template operativo: ${template.name}`,
      );
    startTransition(async () => {
      await createPracticeCommunicationDraftAndRefresh(form);
    });
  }

  if (templates.length === 0)
    return (
      <EmptyState title="Nessun template disponibile">
        I template saranno visibili quando verranno configurati nel CRM.
      </EmptyState>
    );

  return (
    <div className="space-y-4">
      <p className="rounded-2xl bg-fai-blue/5 p-3 text-xs font-bold leading-5 text-fai-blue">
        I dati disponibili vengono compilati automaticamente; verificare sempre
        il testo prima dell’approvazione.
      </p>
      <p className="rounded-2xl bg-fai-orange/10 p-3 text-xs font-bold leading-5 text-fai-orange">
        Template statici di supporto operativo: il catalogo originale non viene
        modificato e le bozze restano modificabili prima dell’utilizzo o
        dell’invio manuale.
      </p>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {templates.map((template) => {
            const compiled = compileTemplate(template, placeholderContext);
            return (
              <article
                key={template.id}
                className={`rounded-2xl border p-4 shadow-sm transition ${selected?.id === template.id ? "border-fai-blue bg-fai-blue/5 ring-1 ring-fai-blue/20" : "border-slate-200 bg-white hover:border-fai-blue/30"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setSelectedId(template.id)}
                    className="text-left font-extrabold text-fai-navy underline-offset-4 hover:underline"
                  >
                    {template.name}
                  </button>
                  <Badge tone={categoryTone[template.category]}>
                    {template.category}
                  </Badge>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-700">
                  {compiled.title}
                </p>
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">
                  {compiled.text}
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-[0.68rem] font-black uppercase tracking-wide text-slate-500">
                  {template.placeholders.map((placeholder) => (
                    <span
                      key={placeholder}
                      className="rounded-full bg-slate-100 px-2.5 py-1 ring-1 ring-slate-200"
                    >
                      {placeholder}
                    </span>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedId(template.id)}
                    className="rounded-xl border border-fai-blue/20 px-3 py-2 text-xs font-bold text-fai-blue"
                  >
                    Visualizza
                  </button>
                  <button
                    type="button"
                    onClick={() => void copyText(template)}
                    className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700"
                  >
                    {copiedId === template.id ? "Copiato" : "Copia"}
                  </button>
                  {canCreateDraft ? (
                    <PrimaryButton
                      type="button"
                      disabled={isPending}
                      onClick={() => createDraft(template)}
                      className="px-3 py-2 text-xs"
                    >
                      Usa template
                    </PrimaryButton>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
        {selected && selectedPreview ? (
          <aside className="rounded-2xl border border-slate-200 bg-slate-50 p-4 shadow-inner lg:sticky lg:top-24 lg:self-start">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={categoryTone[selected.category]}>
                {selected.category}
              </Badge>
              <span className="text-xs font-bold text-slate-500">
                Anteprima completa compilata
              </span>
            </div>
            <h3 className="mt-3 text-lg font-extrabold text-fai-navy">
              {selected.name}
            </h3>
            <p className="mt-3 text-sm font-black text-slate-700">
              Oggetto/titolo suggerito
            </p>
            <p className="mt-1 rounded-xl bg-white p-3 text-sm text-slate-700 ring-1 ring-slate-200">
              {selectedPreview.title}
            </p>
            <p className="mt-3 text-sm font-black text-slate-700">
              Testo suggerito
            </p>
            <p className="mt-1 whitespace-pre-wrap rounded-xl bg-white p-3 text-sm leading-6 text-slate-700 ring-1 ring-slate-200">
              {selectedPreview.text}
            </p>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
