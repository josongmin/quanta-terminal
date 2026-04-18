export { detect, classifyShell } from './detect.js';
export type { DetectionInput, DetectionResult, WizardStep } from './detect.js';

export {
  preview,
  install,
  countSnippetLines,
} from './install.js';
export type {
  PreviewOutcome,
  InstalledOutcome,
  AlreadyInstalledOutcome,
  ErrorOutcome,
  InstallActionOutcome,
} from './install.js';

export { Wizard } from './Wizard.js';
export type { WizardProps } from './Wizard.js';
