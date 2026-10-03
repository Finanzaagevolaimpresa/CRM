export const cases = [
  {
    key: "standard",
    label: "Standard Browser",
    clientType: "persona_fisica",
    serviceCode: "business_plan_presentazione_bancaria",
    partial: true,
  },
  {
    key: "quote",
    label: "Su Preventivo Browser",
    clientType: "societa",
    serviceCode: "consulenza_fiscale",
    partial: false,
  },
  {
    key: "forming",
    label: "Da Costituire Browser",
    clientType: "soggetto_da_costituire",
    serviceCode: "progetti_digitali",
    partial: false,
  },
  {
    key: "percorso",
    label: "Dossier Preanalisi Percorso",
    clientType: "societa",
    serviceCode: "dossier_preanalisi",
    partial: false,
  },
] as const;
