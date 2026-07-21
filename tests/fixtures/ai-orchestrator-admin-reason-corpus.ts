export interface AiOrchestratorAdminReasonCase {
  readonly code: string;
  readonly reason: string;
}

export const AI_ORCHESTRATOR_ADMIN_VALID_REASON_CASES = Object.freeze([
  {
    code: 'ITALIAN_ACCENTS',
    reason: 'Attività amministrativa verificata e sospesa in modalità controllata.',
  },
  {
    code: 'EMBEDDED_RESERVED_FRAGMENTS',
    reason: 'La tokenizzazione e la promptuale revisione risultano completate internamente.',
  },
  {
    code: 'UNICODE_MIN_BOUNDARY',
    reason: '😀'.repeat(10),
  },
  {
    code: 'UNICODE_MAX_BOUNDARY',
    reason: '😀'.repeat(500),
  },
] as const satisfies readonly AiOrchestratorAdminReasonCase[]);

export const AI_ORCHESTRATOR_ADMIN_FORBIDDEN_CONTENT_REASON_CASES = Object.freeze([
  {
    code: 'HTTP_URL',
    reason: 'Consultare http://example.test prima della modifica amministrativa.',
  },
  {
    code: 'HTTPS_URL_CASE_INSENSITIVE',
    reason: 'Consultare HTTPS://EXAMPLE.TEST prima della modifica amministrativa.',
  },
  {
    code: 'HTML_TAG',
    reason: 'Applicare <strong>subito</strong> la modifica amministrativa richiesta.',
  },
  {
    code: 'AT_SIGN',
    reason: 'Contattare operatore@example.test prima della modifica amministrativa.',
  },
  {
    code: 'PASSWORD_WORD',
    reason: 'Usare la password amministrativa durante la modifica controllata.',
  },
  {
    code: 'PASSWD_WORD',
    reason: 'Usare passwd durante la modifica amministrativa controllata.',
  },
  {
    code: 'SECRET_WORD',
    reason: 'Inserire secret nella motivazione della modifica amministrativa.',
  },
  {
    code: 'TOKEN_WORD',
    reason: 'Inserire token nella motivazione della modifica amministrativa.',
  },
  {
    code: 'PROMPT_WORD',
    reason: 'Inserire prompt nella motivazione della modifica amministrativa.',
  },
  {
    code: 'AUTHORIZATION_WORD',
    reason: 'Inserire authorization nella motivazione della modifica amministrativa.',
  },
  {
    code: 'COOKIE_WORD',
    reason: 'Inserire cookie nella motivazione della modifica amministrativa.',
  },
  {
    code: 'API_KEY_SPACE',
    reason: 'Inserire API KEY nella motivazione della modifica amministrativa.',
  },
  {
    code: 'API_KEY_UNDERSCORE',
    reason: 'Inserire api_key nella motivazione della modifica amministrativa.',
  },
  {
    code: 'API_KEY_HYPHEN',
    reason: 'Inserire api-key nella motivazione della modifica amministrativa.',
  },
  {
    code: 'APIKEY_COMPACT',
    reason: 'Inserire apikey nella motivazione della modifica amministrativa.',
  },
  {
    code: 'UNICODE_LONG_S_CASE_FOLD',
    reason: 'Inserire ſecret nella motivazione della modifica amministrativa.',
  },
  {
    code: 'UNICODE_KELVIN_CASE_FOLD',
    reason: 'Inserire cooKie nella motivazione della modifica amministrativa.',
  },
] as const satisfies readonly AiOrchestratorAdminReasonCase[]);

export const AI_ORCHESTRATOR_ADMIN_INVALID_SHAPE_REASON_CASES = Object.freeze([
  {
    code: 'CONTROL_NEWLINE',
    reason: 'Modifica amministrativa con\ncontrollo non consentito.',
  },
  {
    code: 'CONTROL_DELETE',
    reason: 'Modifica amministrativa con\u007fcontrollo non consentito.',
  },
  {
    code: 'TOO_SHORT_CODE_POINTS',
    reason: '😀'.repeat(9),
  },
  {
    code: 'TOO_LONG_CODE_POINTS',
    reason: '😀'.repeat(501),
  },
] as const satisfies readonly AiOrchestratorAdminReasonCase[]);

export const AI_ORCHESTRATOR_ADMIN_INVALID_REASON_CASES = Object.freeze([
  ...AI_ORCHESTRATOR_ADMIN_FORBIDDEN_CONTENT_REASON_CASES,
  ...AI_ORCHESTRATOR_ADMIN_INVALID_SHAPE_REASON_CASES,
]);
