/**
 * i18n string catalog — English-only for now.
 *
 * All user-visible copy lives here keyed by dot-separated path
 * (`widget.subkey`). Widgets fetch via `t('key.path')`. When we add locales
 * later, each key gets a sibling entry in a translation table; the `t()`
 * helper resolves dynamically. Keeping everything in one flat record
 * (rather than nested objects) makes the `keyof` type trivial for the
 * helper and lets us sort / audit keys with a single `Object.keys` call.
 *
 * Interpolation: use `{{param}}` placeholders. `t()` replaces them from the
 * `params` argument. Non-string params are coerced via `String(v)`.
 *
 * Not extracted: dev-log text (`createLogger`, `console.*`), error names
 * thrown at the bridge, stable identifiers. Those stay English for the
 * duration of the product and have no translation value.
 */

export const STRINGS = {
  // Composer
  'composer.placeholder': 'Type a command, then Enter',
  'composer.inputLabel': 'Command input',
  'composer.modeLabel': 'Composer mode: {{mode}}',
  'composer.recentCommandsLabel': 'Recent commands',
  'composer.recentCommandsEmpty': 'No recent commands yet. Press Esc to close.',
  'composer.error.noSession': 'composer.submit: no active session. Start a shell with ⌘T.',
  'composer.error.noBridge': 'composer.submit: host bridge unavailable. Reload the app.',
  'composer.error.writeRejected': 'composer.submit: bridge.write rejected ({{detail}})',

  // Session tabs
  'sessionTabs.rowLabel': 'Sessions',
  'sessionTabs.newTab': 'New session',
  'sessionTabs.newTabTitle': 'New session (⌘T)',
  'sessionTabs.noActive': 'No active session',
  'sessionTabs.close': 'Close {{label}}',
  'sessionTabs.ariaActive': 'Active session {{base}}',
  'sessionTabs.ariaInactive': 'Session {{base}}',

  // Status bar
  'statusBar.region': 'Session status',
  'statusBar.ready': 'ready',
  'statusBar.booting': 'booting',
  'statusBar.exited': 'exited',
  'statusBar.exitedWithCode': 'exited {{code}}',
  'statusBar.error': 'error',
  'statusBar.healthReady': 'Session is ready',
  'statusBar.healthBooting': 'Session is starting',
  'statusBar.healthExited': 'Session has exited',
  'statusBar.healthError': 'Session errored',
  'statusBar.cwdLabel': 'Working directory: {{cwd}}',
  'statusBar.shellLabel': 'Shell: {{shell}}',
  'statusBar.paletteShortcutLabel': 'Open command palette shortcut',
  'statusBar.siInstalledTooltip':
    'Quanta knows the current working directory because shell integration is installed.',
  'statusBar.siInstalledSr': 'shell integration active',
  'statusBar.siPartialTooltip':
    'Shell integration is partial. Some prompts are captured; cwd tracking may estimate.',
  'statusBar.siPartialSr': 'shell integration partial',
  'statusBar.siMissingTooltip':
    'cwd is estimated. Install shell integration for authoritative tracking.',
  'statusBar.siMissingSr': 'cwd is estimated from prompt text',

  // Banner host
  'banner.crash.message': 'Your shell exited unexpectedly. Session has been recovered.',
  'banner.crash.action': 'View crash details',
  'banner.quota.message':
    'History storage is above the soft quota. Older blocks may be pruned.',
  'banner.quota.action': 'Open history settings',
  'banner.secretRescan.message': 'Secret redaction rules changed. Rescanning recent history.',
  'banner.secretRescan.action': 'Review rules',
  'banner.shellIntegration.message':
    'Shell integration is not installed — cwd and prompts are estimated.',
  'banner.shellIntegration.action': 'Install shell integration',
  'banner.shellIntegration.dismiss': 'Not now',
  'banner.dismissDefault': 'Dismiss',

  // Command palette
  'commandPalette.dialogLabel': 'Command palette',
  'commandPalette.searchPlaceholder': 'Search commands',
  'commandPalette.searchLabel': 'Search commands',
  'commandPalette.resultsLabel': 'Command results',
  'commandPalette.emptyHint': 'No sessions yet — press ⌘T to start.',
  'commandPalette.section.sessions': 'Sessions',
  'commandPalette.section.actions': 'Actions',
  'commandPalette.section.history': 'Search history',

  // History search
  'historySearch.dialogLabel': 'History search',
  'historySearch.placeholder': 'Search command history',
  'historySearch.resultsLabel': 'History results',
  'historySearch.typePrompt': 'Type to search past commands.',
  'historySearch.loadingHistory': 'Loading history…',
  'historySearch.noMatches': 'No matches for “{{query}}”.',
  'historySearch.footerNav':
    '↑ ↓ to navigate · Enter open · Esc close',
  'historySearch.resultSingular': 'result',
  'historySearch.resultPlural': 'results',
  'historySearch.hydratingSr': 'Hydrating history',

  // Compare panel
  'comparePanel.dialogLabel': 'Compare runs',
  'comparePanel.title': 'Compare runs',
  'comparePanel.deltaGroupLabel': 'Summary deltas',
  'comparePanel.close': 'Close',
  'comparePanel.closeLabel': 'Close compare panel',
  'comparePanel.truncated':
    'Diff truncated to 10,000 lines per side. Compare shorter outputs for a full view.',
  'comparePanel.previousRun': 'previous run',
  'comparePanel.newRun': 'new run',
  'comparePanel.nextPrevHunk': 'next/prev hunk',
  'comparePanel.hunkSingular': 'hunk',
  'comparePanel.hunkPlural': 'hunks',

  // Shell integration banner
  'shellIntegrationBanner.dismiss': 'Not now',
  'shellIntegrationBanner.install': 'Install',
  'shellIntegrationBanner.body':
    'Shell integration is not installed — block boundaries are estimated. Install a small script into your {{shell}} config for authoritative framing.',

  // Shell integration wizard
  'wizard.title': 'Install shell integration',
  'wizard.detectedShell': 'Detected shell: ',
  'wizard.detect.intro':
    'Quanta uses OSC 133 markers to frame command blocks precisely. Without the integration script, block boundaries are estimated from prompt text.',
  'wizard.detect.cta':
    'Click Preview snippet to see exactly what would be appended to your shell\'s rc file. Nothing is written until you confirm.',
  'wizard.preview.intro': 'This snippet will be appended to ',
  'wizard.preview.alreadyInstalled': 'it looks like it is already installed',
  'wizard.preview.lineCount': '{{count}} lines of script, wrapped in a guarded block',
  'wizard.done.alreadyInstalled': 'Already installed in {{path}}.',
  'wizard.done.appended': 'Appended to {{path}}. Reload your shell to activate.',
  'wizard.error.unknown': 'Unknown error.',
  'wizard.button.notNow': 'Not now',
  'wizard.button.preview': 'Preview snippet',
  'wizard.button.previewLoading': 'Loading…',
  'wizard.button.cancel': 'Cancel',
  'wizard.button.copy': 'Copy',
  'wizard.button.install': 'Install',
  'wizard.button.installLoading': 'Installing…',
  'wizard.button.recheck': 'Re-check',
  'wizard.button.close': 'Close',

  // Title bar
  'titleBar.region': 'Quanta window title bar',
  'titleBar.booting': 'booting',
  'titleBar.openPalette': 'Open command palette',

  // Block list
  'blockList.ariaLabel': 'Command output blocks',
  'blockList.empty': 'Type a command below to get started.',
  'blockList.emptyHint': 'Press Enter to submit.',

  // Block card — export menu
  'blockCard.export.menuLabel': 'Export block',
  'blockCard.export.tooltip': 'Export',
  'blockCard.export.markdown': 'Copy as Markdown',
  'blockCard.export.json': 'Copy as JSON',
  'blockCard.export.text': 'Copy as plain text',
  'blockCard.export.toastMarkdown': 'Exported as Markdown',
  'blockCard.export.toastJson': 'Exported as JSON',
  'blockCard.export.toastText': 'Exported as Text',
  'blockCard.export.toastFailed': 'Export failed: {{reason}}',

  // Session tabs — transcript export
  'sessionTabs.menuLabel': 'Session actions',
  'sessionTabs.menuTooltip': 'Session actions',
  'sessionTabs.exportTranscript': 'Export transcript',
  'sessionTabs.transcriptExported': 'Session transcript copied',
  'sessionTabs.transcriptExportFailed': 'Transcript export failed: {{reason}}',

  // Session transcript document
  'sessionTranscript.title': 'Session transcript',
  'sessionTranscript.header.shell': 'Shell',
  'sessionTranscript.header.cwd': 'Working directory',
  'sessionTranscript.header.startedAt': 'Started',
  'sessionTranscript.header.totalBlocks': 'Total blocks',
  'sessionTranscript.header.totalErrors': 'Total errors',
  'sessionTranscript.empty': 'No blocks in this session.',

  // Settings — notifications
  'settings.sections.notifications': 'Notifications',
  'settings.notifications.description':
    'Post an OS notification when a long-running command finishes while the window is unfocused.',
  'settings.notifications.toggleLabel': 'Notify on long-running command completion',
  'settings.notifications.thresholdLabel': 'Threshold (seconds)',

  // Notifications
  'notifications.commandDone': 'Quanta: your command finished (exit {{exit}}, {{duration}})',

  // Terminal page / chrome
  'terminal.altScreenLabel': 'Full-screen terminal application',
  'terminal.region': 'Terminal',
  'terminal.tuiSr': 'Full-screen TUI application is active; keystrokes go to the shell',
  'terminal.closeConfirm': 'Close this session? This will terminate the shell.',
  'terminal.errorMessage':
    'quanta: shell session failed to start. See the status bar for details.',
  'terminal.rerunBlocked': 'Wait for the previous run to finish before rerunning.',

  // Alt-screen status bar (EPIC-H §4.2)
  'altScreenStatus.ariaLabel': 'Full-screen terminal application status',
  'altScreenStatus.hint': 'Ctrl-D exits',
  'altScreenStatus.nested': '{{inner}} in {{outer}}',
  'altScreenStatus.exitedWithSignal': '{{command}} exited with signal {{signal}}',

  // Degraded-mode banner (EPIC-H §4.4 / ADR 0010 additions)
  'degraded.engine_crashed':
    'Engine crashed; last frame preserved. Restart session to continue.',
  'degraded.restart': 'Restart session',
  'degraded.banner.ariaLabel': 'Session health',

  // Side-by-side harness (EPIC-H §4.3, dev-only)
  'sideBySide.canvasLabel': 'Canvas renderer',
  // historical-xterm-reference: the right pane is now a memory-mirror
  // reference renderer, not xterm. The key name is kept so settings-UI
  // lookups do not break during the EPIC-I removal rollout.
  'sideBySide.xtermLabel': 'Reference mirror',
  'sideBySide.exportDiff': 'Export diff',
  'sideBySide.diffSummaryZero': 'No divergence detected.',
  'sideBySide.diffSummary': '{{count}} divergence(s) over the last {{frames}} frames',

  // Settings panel
  'settings.dialogLabel': 'Settings',
  'settings.close': 'Close settings',
  'settings.sections.appearance': 'Appearance',
  'settings.sections.keyboard': 'Keyboard',
  'settings.sections.shellIntegration': 'Shell Integration',
  'settings.sections.privacy': 'Privacy',
  'settings.theme.label': 'Theme',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.theme.system': 'System',
  'settings.theme.description': 'Controls the palette used by the app chrome and terminal.',
  'settings.keyboard.description':
    'Core shortcuts (read-only for now — remapping lands in a later phase).',
  'settings.keyboard.palette': 'Open command palette',
  'settings.keyboard.history': 'Search command history',
  'settings.keyboard.newSession': 'New session',
  'settings.keyboard.closeSession': 'Close session',
  'settings.keyboard.settings': 'Open settings',
  'settings.shellIntegration.description':
    'Quanta uses OSC 133 markers to frame command blocks precisely.',
  'settings.shellIntegration.status.installed': 'Installed',
  'settings.shellIntegration.status.partial': 'Partial',
  'settings.shellIntegration.status.missing': 'Missing',
  'settings.shellIntegration.install': 'Install shell integration',
  'settings.privacy.description':
    'Telemetry is off. No command text, output, or keystrokes leave the device.',
  'settings.privacy.telemetryOff': 'Telemetry: off',
} as const;

export type StringKey = keyof typeof STRINGS;
