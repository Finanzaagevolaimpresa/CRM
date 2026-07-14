import { constants } from 'fs';
import { access, stat } from 'fs/promises';
import path from 'path';
import { getAiProviderDiagnostics } from '@/lib/ai';
import { getAiControlPolicy } from '@/lib/ai-control-plane';
import { prisma } from '@/lib/prisma';

export type ReadinessStatus = 'OK' | 'Attenzione' | 'Errore' | 'Non configurato';

export type ReadinessCheck = {
  title: string;
  status: ReadinessStatus;
  summary: string;
  details?: string[];
};

function envPresent(name: string) {
  return Boolean(process.env[name]?.trim());
}

function configuredValue(name: string, fallback?: string) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function appEnv() {
  return configuredValue('APP_ENV', process.env.NODE_ENV || 'non impostato') ?? 'non impostato';
}

function authSecretStatus(): ReadinessCheck {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return {
      title: 'AUTH_SECRET',
      status: process.env.NODE_ENV === 'development' ? 'Attenzione' : 'Errore',
      summary: 'Non configurato',
      details: ['Il valore non viene mostrato. In produzione è necessario per firmare le sessioni.'],
    };
  }

  const normalizedSecret = secret.toLowerCase().trim();
  const weakSamples = new Set([
    'replace-with-a-long-random-secret',
    '<generate-a-long-random-secret-at-least-32-bytes>',
    'generate-a-long-random-secret-at-least-32-bytes',
    'changeme',
    'change-me',
    'secret',
    'password',
    'auth_secret',
    'development',
    'default',
    'placeholder',
  ]);
  const weakFragments = ['replace', 'generate', 'placeholder', 'changeme', 'secret', 'password'];
  const looksLikePublicPlaceholder = weakSamples.has(normalizedSecret) || weakFragments.some((fragment) => normalizedSecret.includes(fragment));
  const robust = secret.length >= 32 && !looksLikePublicPlaceholder;
  return {
    title: 'AUTH_SECRET',
    status: robust ? 'OK' : 'Attenzione',
    summary: robust ? 'Presente e apparentemente robusto' : 'Presente ma da rafforzare',
    details: [
      `Lunghezza rilevata: ${secret.length} caratteri. Il valore non viene mai mostrato.`,
      looksLikePublicPlaceholder ? 'Il valore sembra un placeholder pubblico o prevedibile: sostituirlo con un segreto casuale.' : 'Non sono stati rilevati placeholder pubblici noti.',
    ],
  };
}

async function databaseStatus(): Promise<ReadinessCheck> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { title: 'Database', status: 'OK', summary: 'Raggiungibile', details: ['Connessione verificata con query minimale. DATABASE_URL non viene mostrato.'] };
  } catch (error) {
    return { title: 'Database', status: 'Errore', summary: 'Non raggiungibile', details: ['Verificare DATABASE_URL, rete e migrazioni applicate.'] };
  }
}

async function localStorageStatus(root: string): Promise<ReadinessCheck> {
  const resolved = path.resolve(process.cwd(), root);
  const details = [`Percorso configurato: ${root}`];
  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      return { title: 'Storage locale', status: 'Errore', summary: 'Il percorso esiste ma non è una directory', details };
    }
    try {
      await access(resolved, constants.W_OK);
      return { title: 'Storage locale', status: 'OK', summary: 'Directory esistente e scrivibile', details: [...details, 'Scrivibilità verificata.'] };
    } catch {
      return { title: 'Storage locale', status: 'Attenzione', summary: 'Directory esistente ma scrivibilità non verificata', details: [...details, 'Controllare permessi del filesystem o volume persistente.'] };
    }
  } catch {
    return { title: 'Storage locale', status: 'Attenzione', summary: 'Directory non trovata', details: [...details, 'La directory può essere creata al primo upload, ma in produzione va montata su storage persistente.'] };
  }
}

function s3Status(): ReadinessCheck {
  const required = ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  const optional = ['S3_ENDPOINT'];
  const present = required.filter(envPresent);
  const missing = required.filter((name) => !envPresent(name));
  return {
    title: 'S3',
    status: missing.length === 0 ? 'OK' : present.length > 0 ? 'Attenzione' : 'Non configurato',
    summary: missing.length === 0 ? 'Variabili principali presenti' : present.length > 0 ? 'Configurazione incompleta' : 'Variabili S3 non configurate',
    details: [
      ...required.map((name) => `${name}: ${envPresent(name) ? 'presente' : 'non presente'}`),
      ...optional.map((name) => `${name}: ${envPresent(name) ? 'presente' : 'non presente'}`),
      'I valori e le chiavi non vengono mostrati.',
    ],
  };
}

async function aiStatus(): Promise<ReadinessCheck> {
  const diagnostics = getAiProviderDiagnostics();
  try {
    const policy = await getAiControlPolicy();
    const partiallyEnabled = policy.environmentEnabled
      || policy.databaseEnabled
      || policy.allowedModels.length > 0
      || diagnostics.hasApiKey;
    const ready = policy.effectiveExternalProvidersEnabled
      && policy.allowedModels.length > 0
      && diagnostics.hasApiKey;
    return {
      title: 'AI Control Plane',
      status: ready || !partiallyEnabled ? 'OK' : 'Attenzione',
      summary: ready
        ? 'Provider esterni tecnicamente abilitabili'
        : partiallyEnabled
          ? 'Configurazione parziale: chiamate esterne bloccate'
          : 'Fail-closed: provider esterni disabilitati',
      details: [
        `Gate ambiente: ${policy.environmentEnabled ? 'abilitato' : 'disabilitato'}.`,
        `Switch database: ${policy.databaseEnabled ? 'abilitato' : 'disabilitato'}.`,
        `Modelli in allowlist: ${policy.allowedModels.length}.`,
        `AI_API_KEY: ${diagnostics.hasApiKey ? 'presente' : 'non presente'}. Il valore non viene mostrato.`,
        `AI_PROVIDER diagnostica/compatibilità: ${diagnostics.provider}.`,
      ],
    };
  } catch {
    return {
      title: 'AI Control Plane',
      status: 'Errore',
      summary: 'Stato database del Control Plane non leggibile',
      details: ['Le chiamate esterne restano bloccate in assenza di uno stato valido. Nessun segreto viene mostrato.'],
    };
  }
}

function storageProviderStatus(provider: string | undefined, localStorage: ReadinessCheck): ReadinessCheck {
  if (!provider) {
    return {
      title: 'Storage provider',
      status: 'Non configurato',
      summary: 'STORAGE_PROVIDER non impostato',
      details: ['Il runtime usa local come default, ma per readiness produzione è preferibile configurarlo esplicitamente.'],
    };
  }

  if (provider === 'local') {
    return {
      title: 'Storage provider',
      status: localStorage.status === 'Errore' ? 'Errore' : localStorage.status === 'OK' ? 'OK' : 'Attenzione',
      summary: localStorage.status === 'OK' ? 'local supportato dal runtime' : 'local configurato, verificare storage locale',
      details: ['Provider supportato attualmente dal runtime storage: local.'],
    };
  }

  if (provider === 's3') {
    return {
      title: 'Storage provider',
      status: 'Attenzione',
      summary: 'S3 predisposto ma non attivo nel runtime storage',
      details: ['Le variabili S3 possono essere verificate, ma il runtime documentale attuale accetta solo local.'],
    };
  }

  return {
    title: 'Storage provider',
    status: 'Errore',
    summary: `Provider non supportato: ${provider}`,
    details: ['Correggere STORAGE_PROVIDER. Il runtime storage attuale supporta solo local.'],
  };
}

function appUrlStatus(): ReadinessCheck {
  const publicUrl = configuredValue('NEXT_PUBLIC_APP_URL');
  const appUrlValue = configuredValue('APP_URL');
  const value = publicUrl || appUrlValue;
  return {
    title: 'URL applicazione',
    status: value ? 'OK' : 'Non configurato',
    summary: value ? value : 'NEXT_PUBLIC_APP_URL / APP_URL non impostati',
    details: ['Non è obbligatorio per l’avvio, ma è consigliato per deploy online, link assoluti e callback.'],
  };
}

async function backupStatus(): Promise<ReadinessCheck> {
  const script = path.join(process.cwd(), 'scripts/backup-local.sh');
  const docs = path.join(process.cwd(), 'docs/PRODUCTION.md');
  const scriptExists = await stat(script).then((info) => info.isFile()).catch(() => false);
  const docsExist = await stat(docs).then((info) => info.isFile()).catch(() => false);
  return {
    title: 'Backup',
    status: scriptExists ? 'OK' : docsExist ? 'Attenzione' : 'Non configurato',
    summary: scriptExists ? 'Script backup locale presente' : docsExist ? 'Documentazione produzione presente' : 'Script/documentazione non trovati',
    details: [`scripts/backup-local.sh: ${scriptExists ? 'presente' : 'non presente'}`, `docs/PRODUCTION.md: ${docsExist ? 'presente' : 'non presente'}`],
  };
}

export async function getSystemReadinessChecks() {
  const storageProvider = process.env.STORAGE_PROVIDER?.trim();
  const localRoot = configuredValue('LOCAL_DOCUMENT_STORAGE_ROOT', 'storage/private/documents') ?? 'storage/private/documents';
  const database = await databaseStatus();
  const localStorage = await localStorageStatus(localRoot);
  const backup = await backupStatus();
  const ai = await aiStatus();
  const storageProviderCheck = storageProviderStatus(storageProvider, localStorage);

  return [
    { title: 'Ambiente', status: appEnv() === 'production' ? 'OK' : 'Attenzione', summary: `APP_ENV/NODE_ENV: ${appEnv()}`, details: ['Valutare production per il deploy online.'] } satisfies ReadinessCheck,
    database,
    { title: '/api/health', status: database.status === 'OK' ? 'OK' : 'Errore', summary: database.status === 'OK' ? 'Status atteso: 200 ok' : 'Status atteso: 503 degraded', details: ['Il controllo usa la stessa verifica database esposta da /api/health senza mostrare configurazioni sensibili.'] } satisfies ReadinessCheck,
    storageProviderCheck,
    localStorage,
    s3Status(),
    authSecretStatus(),
    ai,
    appUrlStatus(),
    backup,
  ];
}

export const recommendedActions = [
  'Configurare un AUTH_SECRET forte e ruotabile prima del deploy.',
  'Pubblicare l’app dietro HTTPS e verificare URL pubblici/callback.',
  'Verificare backup schedulati e testare periodicamente il restore del database.',
  'Usare storage documentale persistente e testare upload/download.',
  'Mantenere il Control Plane AI fail-closed finché privacy, allowlist, permessi e collaudo staging non sono approvati.',
  'Eseguire un collaudo con utente admin e con utente non admin.',
];
