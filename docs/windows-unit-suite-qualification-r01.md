# Windows unit suite and POSIX security contracts

The standard npm test command uses Node 22 (the version in .nvmrc). On Linux it executes all root and tests/posix test files. On Windows it requires both a native Windows phase and an isolated Linux phase for the POSIX contracts. A missing dependency, failed phase, invalid TAP summary or source change fails the command. No new skip is introduced.

## Reproducible local command

Use the ordinary MSI terminal/authorized Desktop Commander, Node 22 on the process PATH, Git for Windows and Docker Desktop with the local desktop-linux context. Do not change Windows protections or ACLs to make an AppContainer test pass. Stage new test/source files before qualification so they enter the tracked-only snapshot; existing tracked edits are included without committing them.

~~~powershell
node --version
git --version
docker --context desktop-linux version
npm test -- --evidence-dir C:\path\to\a-new-evidence-directory
~~~

The initial node:22-bookworm image must already be available locally. Building the isolated test image installs the repository's locked dependencies from their public package sources. The subsequent POSIX test container has no network, no host mounts, no Docker socket, no ports and no credentials. It runs as UID/GID 1000 with a read-only root, dropped capabilities and a bounded writable temporary filesystem. All fixtures and mocked resources are synthetic. Source snapshots and containers are retained; the command does not prune or delete existing resources.

Each run preserves full stdout/stderr, command arguments, durations, exit codes, the source manifest and SHA-256 hashes in its evidence directory. Windows and Linux counts remain separate; the combined result is complete only when both mandatory phases pass. The ordinary pre-existing DB/PHP skips are still reported and do not qualify those separate CI gates.

## Why 18 contracts execute on Linux

Node documents that Windows process termination does not implement Unix signal delivery, and that Windows chmod does not implement POSIX owner/group/other permission bits. The production release tools also use Bash, Python's Unix identity APIs, GNU tar and executable mock scripts. Those assertions are preserved in eight tests/posix files; they are executed, not marked skipped or replaced with Windows values.

Sources: [Node 22 signal events](https://nodejs.org/docs/latest-v22.x/api/process.html#signal-events), [Node 22 chmod](https://nodejs.org/docs/latest-v22.x/api/fs.html#fschmodpath-mode-callback).

The native storage round trip remains covered on Windows. The original additional 0700 directory / 0600 file proof runs on Linux. The key-file readers retain their fail-closed POSIX checks. Passing this Linux phase does not certify Windows ACLs or authorize storing production keys on Windows.

VNX-03 remains native on Windows: the fixture selects Git for Windows Bash explicitly, checks out canonical bytes with local core.autocrlf=false, disables fixture hooks/signing, and retains the historical hash guards. Cleanup retries are bounded and apply only to the newly created synthetic fixture.

## Original 27 failures

The original full Windows log contained 2,545 cases: 1,599 PASS, 27 FAIL and 919 SKIP. The separately reported 27 targeted passes were a different group. The original run used Node 24.18.0; reproduction uses the required Node 22.23.4. A same-binary capability probe reproduced EPERM on hardlinks and Git config denial inside the AppContainer, while both succeeded through native Desktop Commander. This establishes an execution-context restriction, not a general Windows failure or an SMTP incident.

| ID | Original test | Classification / proved cause | Correction / validation environment |
|---|---|---|---|
| W01 | tests/ai-orchestrator-dormant-worker-process-v1.test.ts — import del modulo Ã¨ privo di timer, log e letture environment | TEST_DEFECT — Percorso assoluto Windows usato come specifier ESM invece di file URL | pathToFileURL(modulePath).href; medesima asserzione |
| W02 | tests/ai-orchestrator-dormant-worker-process-v1.test.ts — entrypoint gestisce SIGTERM/SIGINT senza DB, stack o process.exit | ENVIRONMENT_POSIX_CONTRACT — Il contratto POSIX di child.kill non coincide con la terminazione forzata Windows | Asserzioni originali in fase Linux obbligatoria |
| W03 | tests/ai-orchestrator-dormant-worker-process-v1.test.ts — entrypoint converte EPIPE reale in un solo errore minimizzato senza stack | ENVIRONMENT_POSIX_CONTRACT — Pipeline bash/pipefail/head Unix avviata tramite launcher WSL invece di runtime POSIX | Pipeline originale nella fase Linux isolata |
| W04 | tests/ai-orchestrator-worker-runtime-adapter-v1.test.ts — surrender Ã¨ single-flight e resta disponibile dopo un heartbeat negato | TEST_DEFECT — Regex letterale LF su testo sorgente CRLF | Normalizzazione CRLF solo nella lettura del test |
| W05 | tests/ai-orchestrator-worker-runtime.test.ts — supersession idle Ã¨ batch-limitata, lockata e non richiede gate positivi | TEST_DEFECT — Regex letterale LF su testo sorgente CRLF | Normalizzazione CRLF solo nella lettura del test |
| W06 | tests/lead-projection-normalization-manual-duplicate-resolution.test.ts — identity key file is exact, private, file-only and consensus-bound | ENVIRONMENT_POSIX_CONTRACT — Node Windows non rappresenta i bit POSIX di owner/group/others; stat 0666 anche dopo mode0600 | Guard invariato; prova positiva/negativa su filesystem POSIX |
| W07 | tests/n05-persistent-key-mounts.test.ts — N05 persistent key mounts reject unsafe configuration, files and provenance | ENVIRONMENT_POSIX_CONTRACT — Alias WindowsApps python3, e test dipendente da getuid/getgid/chmod POSIX | Wrapper e suite originali su Linux con errore spawn esplicito |
| W08 | tests/n05-recovery-kit.test.ts — N05 recovery kit rejects unsafe identities, archives, destinations and interrupted copies | ENVIRONMENT_POSIX_CONTRACT — Alias WindowsApps e contratti POSIX di identità/permessi/link | Suite originale Linux, nessuna operazione Docker reale nei mock |
| W09 | tests/n05-recovery-kit.test.ts — N05 backup image check drains the producer and rejects missing images or producer failures | ENVIRONMENT_POSIX_CONTRACT — Wrapper Python e shebang mock Git/Docker richiedono Bash/POSIX | Suite originale Linux, mock sintetici e nessun socket Docker |
| W10 | tests/n05-restore-migration-boundary.test.ts — N15 restore preflight qualifies 43 to 44 and unchanged 44 to 44 without allocating resources | ENVIRONMENT_POSIX_CONTRACT — Due cause distinte: AppContainer nega Git; contratto shell/PATH POSIX non portabile | Controprova capability; preflight originale eseguito Linux |
| W11 | tests/ordinary-email-reconciliation.test.ts — journal survives reopening, is idempotent for exact bytes, and refuses overwrite, truncation and hard links | ENVIRONMENT_EXECUTION_CONTEXT — Restrizione del contesto AppContainer: stessa versione Node e stesso probe falliscono lì e passano nativamente | Nessun cambio al codice: esecuzione Windows nativa autorizzata |
| W12 | tests/release-safety-foundation.test.ts — staging image admission drains the producer and rejects mismatch or inspection failure | ENVIRONMENT_POSIX_CONTRACT — Runtime di shell POSIX non disponibile nella chiamata Windows originale | Prova originale Linux isolata |
| W13 | tests/release-safety-foundation.test.ts — N05 stays migration-free and introduces the complete release-safety surface | TEST_DEFECT — Controllo statico dipendente da terminatori di riga | Normalizzazione della lettura, invarianti identiche |
| W14 | tests/release-safety-foundation.test.ts — restore Compose commands use the generated synthetic env over inherited CI values | ENVIRONMENT_POSIX_CONTRACT — Funzione Bash release-safety provata con percorso/runtime Windows | Funzione originale Linux con risorse sintetiche |
| W15 | tests/release-safety-foundation.test.ts — environment identity accepts only an explicit isolated staging identity | ENVIRONMENT_POSIX_CONTRACT — Contratto Bash/POSIX, non policy applicativa | Guard originale Linux |
| W16 | tests/release-safety-foundation.test.ts — resource provenance permits only exact N05 labels or the explicit production Compose bridge | ENVIRONMENT_POSIX_CONTRACT — Contratto Bash/Python del verificatore risorse | Guard originale Linux, mock Docker |
| W17 | tests/release-safety-foundation.test.ts — authorized production bridge binds the complete certified Compose resource identity | ENVIRONMENT_POSIX_CONTRACT — Contratto Bash/Python di identità container/volumi | Guard originale Linux, mock Docker |
| W18 | tests/release-safety-foundation.test.ts — legacy resource bridge keeps backup quiescence and permits only an explicit running app switch contract | ENVIRONMENT_POSIX_CONTRACT — Contratto Bash/Python non eseguito nel runtime previsto | Guard originale Linux, nessuno switch reale |
| W19 | tests/release-safety-foundation.test.ts — staging env contract denies production database reuse and open gates without exposing values | ENVIRONMENT_POSIX_CONTRACT — Contratto shell/env Unix e controlli POSIX del file | Guard originale Linux |
| W20 | tests/release-safety-foundation.test.ts — backup manifest is strict, checksum-bound and rejects corruption | ENVIRONMENT_POSIX_CONTRACT — Verificatore shell con bit file0600/directory0700 e tar POSIX | Guard originale Linux su soli dump sintetici |
| W21 | tests/release-safety-foundation.test.ts — archive validation rejects traversal and symlink entries before extraction | ENVIRONMENT_POSIX_CONTRACT — GNU tar transform e symlink/POSIX necessari alla fixture | Fixture e guard originali Linux |
| W22 | tests/secure-lead-gateway-v2.test.ts — N12 reads only a protected, bounded and exact synthetic keyring file | ENVIRONMENT_POSIX_CONTRACT — Stat Windows0666; API non rappresenta il contratto POSIX richiesto | Guard invariato e intera prova su Linux |
| W23 | tests/storage.test.ts — sanitizza il nome originale senza conservare separatori di percorso | APPLICATION_DEFECT — path.basename dipende dalla piattaforma e tratta backslash come separatore su Windows | path.posix.basename conserva contratto Linux; regressioni nomi misti |
| W24 | tests/storage.test.ts — salva una chiave root-relative con permessi privati e consente il round trip | ENVIRONMENT_POSIX_CONTRACT — Bit POSIX non implementati da Node/Windows; non prova ACL reali né guasto produttivo Linux | Roundtrip nativo separato più originale completo Linux |
| W25 | tests/vnx03-protected-scope.test.ts — VNX-03 co-modification guard admits historical qualified N15, harness-only and runtime-only changes | TEST_DEFECT — AppContainer + scelta WSL Bash + checkout CRLF incompatibile con hash byte storici | Git Bash esplicito, fixture autocrlf=false, scriptLF; PASS nativo |
| W26 | tests/vnx03-protected-scope.test.ts — VNX-03 co-modification guard rejects unrelated runtime and migration drift with harness changes | TEST_DEFECT — Come W25; cleanup immediato può incrociare handle Windows transitori | Stessa correzione e retry cleanup limitato solo fixture; PASS nativo |
| W27 | tests/website-lead-n01.test.ts — the transaction-local allowance is refreshed before every awaited database operation and commit | TEST_DEFECT — Regex LF su sorgente CRLF | Normalizzazione CRLF nella lettura test, conteggi invariati |

## Additional hosted Windows prerequisites

The first Windows CI run exposed two separate fixture/runtime prerequisites beyond the original 27 failures. Nine technical-upload tests passed a non-canonical temporary path to a guard that deliberately rejects aliases; the fixture now resolves its physical root before configuring storage, leaving that guard unchanged. Two PHP contract tests found a PHP executable but lacked the required extensions. Windows CI now prepares PHP 8.3 with curl, intl, mbstring, mysqli and sodium, and checks those prerequisites explicitly. No test is skipped to hide either failure. CI records both the configured and physical temporary paths.

The existing Linux CI unit job remains the POSIX companion to the Windows native job. A Windows job pass alone does not qualify the complete suite. Local evidence reports native and isolated Linux counts separately; pre-existing skips are disclosed and remain subject to their separate integration/runtime gates.

## Application impact and rollback

The only application change is deterministic POSIX-basename normalization for uploaded names. It preserves the Linux production behavior and produces the same safe name on Windows; existing documents, storage keys, records and permissions are not changed. The rest of the diff concerns test portability and qualification. There is no migration, data backfill, provider activation or email send.

A code rollback restores the previous application image/commit through the existing release gates. No data rollback is required for this diff. This qualification does not complete the wider CRM mandate; Drive folder population remains on Antonio's explicit standby.
