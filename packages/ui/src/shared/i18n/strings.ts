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
  'sessionTabs.unreadActivity': 'New activity',

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
  'statusBar.wslLabel': 'WSL',
  'statusBar.wslTooltip':
    'Session is running under Windows Subsystem for Linux. Windows drives live under /mnt/…',
  'statusBar.wslSr': 'Session running under WSL',
  'statusBar.gitBranchLabel': 'Git branch: {{branch}}',
  'statusBar.gitBranchSr': 'Git branch',
  'statusBar.gitBranchTooltip': 'On branch {{branch}} (repo: {{repo}})',
  'statusBar.gitBranchDetachedTooltip': 'Detached HEAD at {{branch}} (repo: {{repo}})',
  'statusBar.gitBranchDirtyTooltip': 'working tree has uncommitted changes',
  'statusBar.gitBranchAheadTooltip': 'ahead of upstream by {{count}} commit(s)',
  'statusBar.gitBranchBehindTooltip': 'behind upstream by {{count}} commit(s)',
  'statusBar.gitBranchDirtySr': '(dirty)',
  'statusBar.gitBranchAheadSr': '(ahead {{count}})',
  'statusBar.gitBranchBehindSr': '(behind {{count}})',

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

  // Block card — "Copy as Markdown" action (palette, menu, toasts).
  'blockCard.copyAsMarkdown.label': 'Copy as Markdown',
  'blockCard.copyAsMarkdown.description':
    'Copy the selected output (or the whole block) as a Markdown code fence',
  'blockCard.copyAsMarkdown.toastFull': 'Copied block as Markdown',
  'blockCard.copyAsMarkdown.toastSelection': 'Copied selection as Markdown',
  'blockCard.copyAsMarkdown.toastFailed': 'Copy as Markdown failed: {{reason}}',
  'palette.copyBlockAsMarkdown': 'Copy block as Markdown',
  'palette.copyBlockAsMarkdown.description':
    'Copy the focused block (or current selection within it) as a Markdown code fence',

  // Session tabs — transcript export
  'sessionTabs.menuLabel': 'Session actions',
  'sessionTabs.menuTooltip': 'Session actions',
  'sessionTabs.exportTranscript': 'Export transcript',
  'sessionTabs.transcriptExported': 'Session transcript copied',
  'sessionTabs.transcriptExportFailed': 'Transcript export failed: {{reason}}',

  // Session tabs — hover preview
  'sessionTabs.preview.noOutput': '(no output)',
  'sessionTabs.preview.healthReady': 'ready',
  'sessionTabs.preview.healthBooting': 'booting',
  'sessionTabs.preview.healthExited': 'exited',
  'sessionTabs.preview.healthError': 'error',
  'sessionTabs.preview.cwdLabel': 'cwd',
  'sessionTabs.preview.shellLabel': 'shell',

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

  // Settings — secrets
  'settings.sections.secrets': 'Secrets',
  'settings.secrets.description':
    'Detect API keys, tokens, and credentials in command output and hide them behind a per-block reveal toggle.',
  'settings.secrets.toggleLabel': 'Redact secrets in output',

  // Settings — a11y screen-reader announcements
  'settings.sections.a11yAnnounce': 'Screen Reader',
  'settings.a11yAnnounce.description':
    'Announce new terminal output through an aria-live region so screen readers (VoiceOver, NVDA, JAWS) can read it aloud.',
  'settings.a11yAnnounce.toggleLabel': 'Announce new output to screen reader',
  'settings.a11yAnnounce.modeLabel': 'Politeness',
  'settings.a11yAnnounce.mode.polite': 'Polite (wait for pause)',
  'settings.a11yAnnounce.mode.assertive': 'Assertive (interrupt)',
  'settings.a11yAnnounce.shortcutHint': 'Shortcut: {{shortcut}} cycles off / polite / assertive.',

  // Settings — bell
  'settings.sections.bell': 'Bell',
  'settings.bell.description':
    'How to surface terminal bell (BEL) events. Visual flashes the screen briefly; audible plays a short beep.',
  'settings.bell.visualLabel': 'Flash screen on bell',
  'settings.bell.audibleLabel': 'Play sound on bell',

  // Block card — "did you mean?" command correction (shown on exit 127)
  'blockCard.didYouMean.question': 'Did you mean',
  'blockCard.didYouMean.rerun': 'Rerun with this',
  'blockCard.didYouMean.dismiss': 'Dismiss suggestion',

  // AI explain-error panel (shown below a failed block)
  'aiExplain.idleLabel': 'Explain this error',
  'aiExplain.idleDescription': 'Ask AI why this command failed',
  'aiExplain.loading': 'Asking AI\u2026',
  'aiExplain.errorMessage': 'Couldn\u2019t explain. Try again.',
  'aiExplain.retry': 'Retry',
  'aiExplain.notConfigured':
    'AI provider not configured. Set up in settings.',
  'aiExplain.dismiss': 'Dismiss explanation',
  'aiExplain.panelLabel': 'AI explanation',
  'aiExplain.shortcutHint': 'E',

  // Settings — AI explain failed commands
  'settings.sections.aiExplain': 'AI',
  'settings.aiExplain.description':
    'Offer an inline "Explain this error" action on blocks that exit non-zero. Uses the configured AI provider.',
  'settings.aiExplain.toggleLabel': 'Explain failed commands',

  // Command palette — explain last failure
  'palette.explainLastFailure': 'Explain last failure',
  'palette.explainLastFailure.description':
    'Ask AI to explain the most recent failed command in this session',

  // Block card — secrets
  'blockCard.secrets.showLabel': 'Show secrets',
  'blockCard.secrets.hideLabel': 'Hide secrets',
  'blockCard.secrets.count': '{{count}} secret hidden',
  'blockCard.secrets.countPlural': '{{count}} secrets hidden',

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

  // TUI surface a11y (announcement + aria labels)
  'tui.announce.entered': 'Entered TUI mode{{command}}',
  'tui.announce.exited': 'Exited TUI mode, back to shell',
  'tui.input.ariaLabel': 'Terminal input (Press Cmd+Shift+Escape to release keyboard)',
  'tui.render.ariaLabel': 'Terminal screen',

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
  'settings.keyboard.outputSearch': 'Find in output',
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
  'settings.sections.sessionProfiles': 'Session Profiles',
  'settings.sessionProfiles.description':
    'Named shell + working-directory + env combinations. New sessions spawn with the default profile unless overridden.',
  'settings.sessionProfiles.empty': 'No profiles yet. Click "Add profile" to create one.',
  'settings.sessionProfiles.add': 'Add profile',
  'settings.sessionProfiles.edit': 'Edit',
  'settings.sessionProfiles.remove': 'Remove',
  'settings.sessionProfiles.save': 'Save',
  'settings.sessionProfiles.cancel': 'Cancel',
  'settings.sessionProfiles.setDefault': 'Set default',
  'settings.sessionProfiles.defaultBadge': 'Default',
  'settings.sessionProfiles.nameLabel': 'Name',
  'settings.sessionProfiles.shellLabel': 'Shell',
  'settings.sessionProfiles.shell.zsh': 'zsh',
  'settings.sessionProfiles.shell.bash': 'bash',
  'settings.sessionProfiles.shell.fish': 'fish',
  'settings.sessionProfiles.shell.custom': 'Custom path',
  'settings.sessionProfiles.shell.hostDefault': 'Host default',
  'settings.sessionProfiles.customShellLabel': 'Custom shell path',
  'settings.sessionProfiles.cwdLabel': 'Startup working directory',
  'settings.sessionProfiles.cwdPlaceholder': 'leave empty to inherit',
  'settings.sessionProfiles.envLabel': 'Startup environment variables',
  'settings.sessionProfiles.envKeyPlaceholder': 'KEY',
  'settings.sessionProfiles.envValuePlaceholder': 'value',
  'settings.sessionProfiles.envAddRow': 'Add variable',
  'settings.sessionProfiles.envRemoveRow': 'Remove',
  'settings.sessionProfiles.envKeyInvalid':
    'Env names must match /^[A-Z_][A-Z0-9_]*$/ (POSIX).',
  'settings.sessionProfiles.envCapReached':
    'At most 64 variables per profile.',
  'settings.sessionProfiles.startupCommandsLabel': 'Startup commands',
  'settings.sessionProfiles.startupCommandsHelp':
    'One command per line. Each runs automatically after the shell boots, as if typed.',
  'settings.privacy.description':
    'Telemetry is off. No command text, output, or keystrokes leave the device.',
  'settings.privacy.telemetryOff': 'Telemetry: off',

  // Settings — shell history import
  'settings.sections.shellHistoryImport': 'Shell History Import',
  'settings.shellHistoryImport.description':
    'Quanta can seed its history index from your existing ~/.zsh_history, ~/.bash_history, or ~/.config/fish/fish_history so autosuggest and the command palette are useful immediately. Import runs once on first launch; nothing is written back to your shell files.',
  'settings.shellHistoryImport.status.imported':
    'Imported {{count}} commands from {{source}}.',
  'settings.shellHistoryImport.status.empty': 'No imported commands yet.',
  'settings.shellHistoryImport.lastImport': 'Last import: {{when}}',
  'settings.shellHistoryImport.reimport': 'Re-import',
  'settings.shellHistoryImport.reimporting': 'Re-importing…',
  'settings.shellHistoryImport.clear': 'Clear imported',
  'settings.shellHistoryImport.error.noBridge':
    'Host bridge unavailable — cannot read shell history files.',
  'settings.shellHistoryImport.error.skipReason':
    'Import skipped ({{reason}}).',

  // Font settings
  'settings.sections.font': 'Font',
  'settings.font.description':
    'Monospace font used across the terminal, command blocks, composer, and TUI. Uninstalled faces fall back to System Monospace automatically.',
  'settings.font.familyLabel': 'Font family',
  'settings.font.sizeLabel': 'Size',
  'settings.font.sizePx': '{{size}}px',
  'settings.font.ligaturesLabel': 'Programming ligatures (calt, liga)',
  'settings.font.previewLabel': 'Preview',
  'settings.font.fallbackNote':
    'Uninstalled fonts fall back to System Monospace — no remote download.',

  // Keybindings (customizable shortcuts)
  'settings.sections.keybindings': 'Shortcuts',
  'keybindings.description':
    'Customize shortcuts for app-level actions. Click Record and press a combination; Esc cancels.',
  'keybindings.record': 'Record',
  'keybindings.recording': 'Press keys...',
  'keybindings.recordHint': 'Press any combination, Esc to cancel',
  'keybindings.reset': 'Reset',
  'keybindings.resetAll': 'Reset all',
  'keybindings.conflictBadge': 'conflict',
  'keybindings.conflictWarning': 'Also bound to: {{actions}}',
  'keybindings.action.palette': 'Open command palette',
  'keybindings.action.newSession': 'New session',
  'keybindings.action.closeSession': 'Close session',
  'keybindings.action.splitRight': 'Split pane right',
  'keybindings.action.outputSearch': 'Find in output',
  'keybindings.action.historySearch': 'Search history',
  'keybindings.action.settings': 'Open settings',
  'keybindings.action.clearTerminal': 'Clear terminal',
  'keybindings.action.focusTerminal': 'Focus terminal',

  // Output search
  'outputSearch.placeholder': 'Find in output',
  'outputSearch.ariaLabel': 'Find in output',
  'outputSearch.regionLabel': 'Search block output',
  'outputSearch.countLive': 'Results',
  'outputSearch.countOf': '{{current}} of {{total}} matches',
  'outputSearch.countNone': 'No matches',
  'outputSearch.countEmpty': '',
  'outputSearch.invalidRegex': '/invalid regex/',
  'outputSearch.hint': '↵ next · ⇧↵ prev',
  'outputSearch.toggleRegex': 'Regex',
  'outputSearch.toggleRegexTooltip': 'Regular expression (.*)',
  'outputSearch.toggleCase': 'Aa',
  'outputSearch.toggleCaseTooltip': 'Match case',
  'outputSearch.toggleWord': 'W',
  'outputSearch.toggleWordTooltip': 'Whole word',
  'outputSearch.prev': 'Previous match',
  'outputSearch.next': 'Next match',
  'outputSearch.close': 'Close output search',

  // Paste safety
  'pasteSafety.dialogLabel': 'Confirm paste',
  'pasteSafety.title.danger': 'Dangerous paste detected',
  'pasteSafety.title.warn': 'Review before pasting',
  'pasteSafety.reasonsLabel': 'Why this was flagged',
  'pasteSafety.previewLabel': 'Preview',
  'pasteSafety.truncated': 'Preview truncated. {{chars}} characters total.',
  'pasteSafety.cancel': 'Cancel',
  'pasteSafety.confirm': 'Paste Anyway',
  'pasteSafety.badgeDanger': 'danger',
  'pasteSafety.badgeWarn': 'warn',

  // Composer — password mode
  'composer.passwordMode': 'password mode',
  'composer.passwordMode.aria':
    'Password mode active: typed characters are masked and not stored in history',

  // Pane layout (split panes)
  'paneLayout.splitH': 'Split Right',
  'paneLayout.splitV': 'Split Down',
  'paneLayout.nextPane': 'Next Pane',
  'paneLayout.closePane': 'Close Pane',
  'paneLayout.paneLabel': 'Pane {{id}}',
  'paneLayout.resizerLabel': 'Resize panes',
  'paneLayout.zoomBadge': 'zoomed',
  'paneLayout.zoomBadgeTooltip': 'Pane maximized — {{shortcut}} to restore',
  'paneLayout.zoomToggle': 'Toggle pane zoom',
  'paneLayout.zoomToggleDescription':
    'Maximize the focused pane (hides siblings without closing them). Press again to restore.',
  'paneLayout.zoomedAnnounce': 'Pane zoomed',
  'paneLayout.restoredAnnounce': 'Pane restored',
  'keybindings.action.zoomPane': 'Toggle pane zoom',

  // Session record (asciicast v2)
  'sessionRecord.commands.start.label': 'Session: Start recording',
  'sessionRecord.commands.start.description':
    'Capture all output from the active shell as an asciicast .cast file',
  'sessionRecord.commands.stop.label': 'Session: Stop recording',
  'sessionRecord.commands.stop.description': 'End the asciicast capture and open the save dialog',
  'sessionRecord.indicator.label': 'REC',
  'sessionRecord.indicator.aria': 'Recording session, {{time}} elapsed',
  'sessionRecord.toast.noSession': 'No active session to record.',
  'sessionRecord.toast.alreadyRecording': 'A session recording is already in progress.',
  'sessionRecord.toast.overflow':
    'Recording stopped: buffer cap (32 MiB) reached. You can still save what was captured.',
  'sessionRecord.modal.title': 'Recording stopped',
  'sessionRecord.modal.statsLabel': 'Recording statistics',
  'sessionRecord.modal.statDuration': 'Duration',
  'sessionRecord.modal.statBytes': 'Captured',
  'sessionRecord.modal.statEvents': 'Events',
  'sessionRecord.modal.copy': 'Copy to clipboard',
  'sessionRecord.modal.download': 'Download .cast',
  'sessionRecord.modal.discard': 'Discard',
  'sessionRecord.modal.copyOk': 'Asciicast copied to clipboard.',
  'sessionRecord.modal.copyFail': 'Could not copy to clipboard.',
  'sessionRecord.modal.copyUnavailable': 'Clipboard access is unavailable in this environment.',
  'sessionRecord.modal.downloadOk': 'Downloading asciicast file.',
  'sessionRecord.modal.downloadFail': 'Could not start the download.',

  // Block tags (SOTA++ tagging feature)
  'blockCard.tags.addButton': 'Tag',
  'blockCard.tags.addLabel': 'Add a tag to this block',
  'blockCard.tags.removeLabel': 'Remove tag {{tag}}',
  'blockCard.tags.chipLabel': 'Filter by tag {{tag}}',
  'blockCard.tags.popoverLabel': 'Tag editor',
  'blockCard.tags.inputPlaceholder': 'tag name',
  'blockCard.tags.invalid':
    'Tags must be 1-24 characters: lowercase letters, digits, _ or -.',
  'blockFilter.bar.activeLabel': 'Filtering by',
  'blockFilter.bar.removeTag': 'Remove {{tag}} from filter',
  'blockFilter.bar.clear': 'Clear',
  'blockFilter.bar.clearLabel': 'Clear all tag filters',
  'blockFilter.bar.count': '{{matched}} of {{total}}',
  'blockFilter.bar.modeAny': 'Any',
  'blockFilter.bar.modeAll': 'All',
  'blockFilter.bar.modeLabel': 'Filter mode',
  'palette.tagActiveBlock': 'Tag active block...',
  'palette.tagActiveBlock.description': 'Open the tag editor for the focused block',
  'palette.clearTagFilter': 'Clear tag filters',
  'palette.clearTagFilter.description': 'Remove every active tag from the block filter',

  // Workspace snapshots (SOTA++ layout capture feature)
  'workspaceSnapshot.palette.save': 'Workspace: Save snapshot...',
  'workspaceSnapshot.palette.save.description':
    'Capture the current layout (sessions, panes, filters) under a name',
  'workspaceSnapshot.palette.restore': 'Workspace: Restore snapshot...',
  'workspaceSnapshot.palette.restore.description':
    'Switch to a saved workspace layout',
  'workspaceSnapshot.palette.delete': 'Workspace: Delete snapshot...',
  'workspaceSnapshot.palette.delete.description': 'Remove a saved workspace layout',
  'workspaceSnapshot.palette.toggleAutoRestore': 'Workspace: Toggle auto-restore',
  'workspaceSnapshot.palette.toggleAutoRestore.description':
    'Automatically re-open the last workspace on next launch',
  'workspaceSnapshot.prompt.saveName':
    'Name this workspace snapshot (e.g. "deploy flow")',
  'workspaceSnapshot.prompt.restoreName': 'Restore which snapshot?',
  'workspaceSnapshot.prompt.deleteName': 'Delete which snapshot?',
  'workspaceSnapshot.toast.saved': 'Saved workspace snapshot "{{name}}".',
  'workspaceSnapshot.toast.restored': 'Restored workspace snapshot "{{name}}".',
  'workspaceSnapshot.toast.deleted': 'Deleted workspace snapshot "{{name}}".',
  'workspaceSnapshot.toast.autoRestoreOn': 'Auto-restore enabled.',
  'workspaceSnapshot.toast.autoRestoreOff': 'Auto-restore disabled.',
  'workspaceSnapshot.toast.empty': 'No saved snapshots yet.',
  'workspaceSnapshot.toast.notFound': 'No snapshot named "{{name}}".',
  'workspaceSnapshot.settings.sectionTitle': 'Workspace snapshots',
  'workspaceSnapshot.settings.description':
    'Saved layouts — sessions, splits, zoom, and filter tags. Restore to switch the whole workspace.',
  'workspaceSnapshot.settings.autoRestoreLabel':
    'Re-open the last workspace automatically on launch',
  'workspaceSnapshot.settings.autoSectionTitle': 'Automatic',
  'workspaceSnapshot.settings.autoEmpty': 'No automatic snapshot yet.',
  'workspaceSnapshot.settings.autoCapturedAt': 'Captured {{when}}',
  'workspaceSnapshot.settings.namedSectionTitle': 'Named',
  'workspaceSnapshot.settings.namedEmpty': 'No named snapshots saved.',
  'workspaceSnapshot.settings.save': 'Save current workspace...',
  'workspaceSnapshot.settings.restore': 'Restore',
  'workspaceSnapshot.settings.delete': 'Delete',
  'workspaceSnapshot.settings.sessionCount': '{{count}} sessions',
} as const;

export type StringKey = keyof typeof STRINGS;
