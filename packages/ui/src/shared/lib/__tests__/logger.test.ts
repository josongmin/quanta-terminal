import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';

describe('createLogger', () => {
  const prevFlag = globalThis.__QUANTA_DEBUG__;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.__QUANTA_DEBUG__ = prevFlag;
  });

  it('debug/info are suppressed when the global flag is false', () => {
    globalThis.__QUANTA_DEBUG__ = false;
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const log = createLogger('t');
    log.debug('hidden');
    log.info('hidden');
    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('warn/error always pass through', () => {
    globalThis.__QUANTA_DEBUG__ = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('t');
    log.warn('oops');
    log.error('boom');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('debug/info fire when the flag is true', () => {
    globalThis.__QUANTA_DEBUG__ = true;
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const log = createLogger('t');
    log.debug('visible');
    expect(debug).toHaveBeenCalledTimes(1);
  });
});
