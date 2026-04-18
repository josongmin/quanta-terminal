import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallShellIntegrationReply } from '@quanta/host-common';
import { Wizard } from '../Wizard.js';
import type { DetectionResult } from '../detect.js';
import type { InstallActionOutcome, PreviewOutcome, ErrorOutcome } from '../install.js';

const SNIPPET =
  '\n# >>> quanta shell integration >>>\n' +
  'echo "hello from quanta"\n' +
  '# <<< quanta shell integration <<<\n';

function makeReply(overrides: Partial<InstallShellIntegrationReply> = {}): InstallShellIntegrationReply {
  return {
    targetPath: '/home/user/.zshrc',
    snippet: SNIPPET,
    alreadyInstalled: false,
    mutated: false,
    lineCount: 100,
    ...overrides,
  };
}

const detection: DetectionResult = {
  needsInstall: true,
  shell: 'zsh',
  rawShell: '/bin/zsh',
  initialStep: 'detect',
};

function makeOverrides(opts: {
  previewResult?: PreviewOutcome | ErrorOutcome;
  installResult?: InstallActionOutcome;
} = {}) {
  const preview = vi.fn(async () =>
    opts.previewResult ?? ({ kind: 'preview', reply: makeReply() } as PreviewOutcome),
  );
  const install = vi.fn(async () =>
    opts.installResult ?? ({ kind: 'installed', reply: makeReply({ mutated: true }) } as InstallActionOutcome),
  );
  return { preview, install };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('<Wizard /> step flow', () => {
  it('renders nothing when not open', () => {
    const overrides = makeOverrides();
    const { container } = render(
      <Wizard open={false} onClose={() => {}} detection={detection} overrides={overrides} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('starts on the detect step with a Preview button', () => {
    const overrides = makeOverrides();
    render(<Wizard open onClose={() => {}} detection={detection} overrides={overrides} />);
    expect(screen.getByTestId('step-detect')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-preview-button')).toBeInTheDocument();
    // preview has NOT been called just by opening the wizard — typed-to-confirm.
    expect(overrides.preview).not.toHaveBeenCalled();
  });

  it('clicking Preview fetches the snippet (with confirm=false) and advances to preview step', async () => {
    const overrides = makeOverrides();
    render(<Wizard open onClose={() => {}} detection={detection} overrides={overrides} />);
    act(() => {
      screen.getByTestId('wizard-preview-button').click();
    });
    await waitFor(() => expect(screen.getByTestId('step-preview')).toBeInTheDocument());
    expect(overrides.preview).toHaveBeenCalledOnce();
    expect(overrides.preview).toHaveBeenCalledWith('zsh');
    expect(screen.getByTestId('target-path')).toHaveTextContent('/home/user/.zshrc');
    expect(screen.getByTestId('snippet-preview').textContent).toContain('echo "hello from quanta"');
    // Still no install call yet.
    expect(overrides.install).not.toHaveBeenCalled();
  });

  it('clicking Install from the preview step passes userConfirmed=true to install()', async () => {
    const overrides = makeOverrides();
    render(<Wizard open onClose={() => {}} detection={detection} overrides={overrides} />);
    act(() => {
      screen.getByTestId('wizard-preview-button').click();
    });
    await waitFor(() => expect(screen.getByTestId('step-preview')).toBeInTheDocument());
    act(() => {
      screen.getByTestId('wizard-install-button').click();
    });
    await waitFor(() => expect(screen.getByTestId('step-done')).toBeInTheDocument());
    expect(overrides.install).toHaveBeenCalledOnce();
    expect(overrides.install).toHaveBeenCalledWith('zsh', true);
    expect(screen.getByTestId('step-done').textContent).toMatch(/Appended/);
  });

  it('reports already-installed when the bridge reply says so', async () => {
    const overrides = makeOverrides({
      installResult: {
        kind: 'already-installed',
        reply: makeReply({ alreadyInstalled: true, mutated: false }),
      },
    });
    render(<Wizard open onClose={() => {}} detection={detection} overrides={overrides} />);
    act(() => screen.getByTestId('wizard-preview-button').click());
    await waitFor(() => expect(screen.getByTestId('step-preview')).toBeInTheDocument());
    act(() => screen.getByTestId('wizard-install-button').click());
    await waitFor(() => expect(screen.getByTestId('step-done')).toBeInTheDocument());
    expect(screen.getByTestId('step-done').textContent).toMatch(/Already installed/);
  });

  it('shows the error step when preview rejects', async () => {
    const overrides = makeOverrides({
      previewResult: { kind: 'error', message: 'backend explode' },
    });
    render(<Wizard open onClose={() => {}} detection={detection} overrides={overrides} />);
    act(() => screen.getByTestId('wizard-preview-button').click());
    await waitFor(() => expect(screen.getByTestId('step-error')).toBeInTheDocument());
    expect(screen.getByTestId('step-error').textContent).toMatch(/backend explode/);
  });

  it('Escape key closes the modal', () => {
    const onClose = vi.fn();
    const overrides = makeOverrides();
    render(<Wizard open onClose={onClose} detection={detection} overrides={overrides} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('backdrop click closes the modal', () => {
    const onClose = vi.fn();
    const overrides = makeOverrides();
    render(<Wizard open onClose={onClose} detection={detection} overrides={overrides} />);
    const backdrop = screen.getByTestId('shell-integration-wizard-backdrop');
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Not now button on the detect step closes without calling preview', () => {
    const onClose = vi.fn();
    const overrides = makeOverrides();
    render(<Wizard open onClose={onClose} detection={detection} overrides={overrides} />);
    const notNow = screen.getByRole('button', { name: /not now/iu });
    act(() => notNow.click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(overrides.preview).not.toHaveBeenCalled();
  });

  it('opening the wizard NEVER installs by itself (typed-to-confirm invariant)', () => {
    const overrides = makeOverrides();
    render(<Wizard open onClose={() => {}} detection={detection} overrides={overrides} />);
    expect(overrides.install).not.toHaveBeenCalled();
    expect(overrides.preview).not.toHaveBeenCalled();
  });

  it('renders the detected shell in the header', () => {
    const overrides = makeOverrides();
    render(
      <Wizard
        open
        onClose={() => {}}
        detection={{ needsInstall: true, shell: 'fish', rawShell: '/usr/bin/fish', initialStep: 'detect' }}
        overrides={overrides}
      />,
    );
    const header = screen.getByRole('dialog');
    expect(header.textContent).toMatch(/fish/);
    expect(header.textContent).toMatch(/usr\/bin\/fish/);
  });
});
