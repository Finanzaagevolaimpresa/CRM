import { constants } from 'fs';
import { access, stat } from 'fs/promises';
import path from 'path';
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

  const weakSamples = new Set(['changeme', 'change-me', 'secret', 'password', 'auth_secret', 'development']);
  const robust = secret.length >= 32 && !weakSamples.has(secret.toLowerCase());
  return {
    title: 'AUTH_SECRET',
    status: robust ? 'OK' : 'Attenzione',
    summary: robust ? 'Presente e apparentemente robusto' : 'Presente ma da rafforzare',
    details: [`Lunghezza rilevata: ${secret.length} caratteri. Il valore non viene mai mostrato.`],
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

function aiStatus(): ReadinessCheck {
  const provider = configuredValue('AI_PROVIDER', 'mock') ?? 'mock';
  const hasApiKey = envPresent('AI_API_KEY');
  return {
    title: 'AI provider',
    status: provider === 'openai' && !hasApiKey ? 'Attenzione' : 'OK',
    summary: `${provider} configurato`,
    details: [`AI_API_KEY: ${hasApiKey ? 'presente' : 'non presente'}. Il valore non viene mostrato.`],
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
  const storageProvider = configuredValue('STORAGE_PROVIDER', 'local') ?? 'local';
  const localRoot = configuredValue('LOCAL_DOCUMENT_STORAGE_ROOT', 'storage/private/documents') ?? 'storage/private/documents';
  const database = await databaseStatus();
  const localStorage = await localStorageStatus(localRoot);
  const backup = await backupStatus();

  return [
    { title: 'Ambiente', status: appEnv() === 'production' ? 'OK' : 'Attenzione', summary: `APP_ENV/NODE_ENV: ${appEnv()}`, details: ['Valutare production per il deploy online.'] } satisfies ReadinessCheck,
    database,
    { title: '/api/health', status: database.status === 'OK' ? 'OK' : 'Errore', summary: database.status === 'OK' ? 'Status atteso: 200 ok' : 'Status atteso: 503 degraded', details: ['Il controllo usa la stessa verifica database esposta da /api/health senza mostrare configurazioni sensibili.'] } satisfies ReadinessCheck,
    { title: 'Storage provider', status: storageProvider ? 'OK' : 'Non configurato', summary: storageProvider, details: ['Provider supportato attualmente: local; S3 predisposto via variabili.'] } satisfies ReadinessCheck,
    localStorage,
    s3Status(),
    authSecretStatus(),
    aiStatus(),
    appUrlStatus(),
    backup,
  ];
}

export const recommendedActions = [
  'Configurare un AUTH_SECRET forte e ruotabile prima del deploy.',
  'Pubblicare l’app dietro HTTPS e verificare URL pubblici/callback.',
  'Verificare backup schedulati e testare periodicamente il restore del database.',
  'Usare storage documentale persistente e testare upload/download.',
  'Eseguire un collaudo con utente admin e con utente non admin.',
];
