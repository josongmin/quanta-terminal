import { describe, expect, it } from 'vitest';
import { classifyShell, detect } from '../detect.js';

describe('classifyShell', () => {
  it('classifies /bin/zsh as zsh', () => {
    expect(classifyShell('/bin/zsh')).toBe('zsh');
  });

  it('classifies /usr/local/bin/fish as fish', () => {
    expect(classifyShell('/usr/local/bin/fish')).toBe('fish');
  });

  it('classifies /bin/bash as bash', () => {
    expect(classifyShell('/bin/bash')).toBe('bash');
  });

  it('classifies sh / dash / unknown as bash (safe default)', () => {
    expect(classifyShell('/bin/sh')).toBe('bash');
    expect(classifyShell('/bin/dash')).toBe('bash');
    expect(classifyShell('/opt/weird/thingy')).toBe('bash');
  });

  it('handles a bare basename (no slashes)', () => {
    expect(classifyShell('zsh')).toBe('zsh');
    expect(classifyShell('fish')).toBe('fish');
  });

  it('is case-insensitive', () => {
    expect(classifyShell('/bin/ZSH')).toBe('zsh');
    expect(classifyShell('/bin/Fish')).toBe('fish');
  });
});

describe('detect', () => {
  it('flags needsInstall when the session reports missing integration', () => {
    const result = detect({ shellIntegration: 'missing', shell: '/bin/zsh' });
    expect(result.needsInstall).toBe(true);
    expect(result.shell).toBe('zsh');
    expect(result.initialStep).toBe('detect');
  });

  it('flags needsInstall when partially integrated', () => {
    const result = detect({ shellIntegration: 'partial', shell: '/bin/bash' });
    expect(result.needsInstall).toBe(true);
    expect(result.shell).toBe('bash');
  });

  it('clears needsInstall when integration is installed', () => {
    const result = detect({ shellIntegration: 'installed', shell: '/bin/fish' });
    expect(result.needsInstall).toBe(false);
    expect(result.shell).toBe('fish');
  });

  it('preserves the raw shell string for diagnostics', () => {
    const result = detect({ shellIntegration: 'missing', shell: '/opt/unknown-shell-v2' });
    expect(result.rawShell).toBe('/opt/unknown-shell-v2');
    // Unknown shells fall back to bash.
    expect(result.shell).toBe('bash');
  });
});
