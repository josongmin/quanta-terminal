/**
 * Public surface for the secret-detect feature. UI consumers (BlockCard,
 * SettingsPanel) import only from here so the internal module layout can
 * evolve without churning call sites.
 */

export { detectSecrets, maskSecretsInText, type SecretMatch } from './detector.js';
export {
  SECRET_PATTERNS,
  labelForKind,
  type SecretKind,
  type SecretPattern,
} from './patterns.js';
export {
  useSecretRedactSettings,
  useSecretRevealStore,
  useBlockRevealed,
  readStoredRedactSettings,
  SECRET_REDACT_STORAGE_KEY,
  type SecretRedactSettings,
  type SecretRedactStore,
  type SecretRevealState,
  type SecretRevealStore,
} from './settings.js';
export {
  detectPasswordPrompt,
  tailLines,
  PASSWORD_PROMPT_KINDS,
  type PasswordPromptMatch,
} from './password-prompt.js';
