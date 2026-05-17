import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emailConfig } from './email-dispatcher.js';
import { dispatch } from './dispatcher.js';
import type { AlertRecord } from './store.js';

const SAMPLE_ALERT: AlertRecord = {
  triggerType: 'cost_spike',
  pairKey: '__global__',
  payload: { spendUsd: 99, capUsd: 50, windowStart: '2026-05-16T00:00:00Z' },
};

/**
 * The dispatcher orchestrates Telegram → email fallback. The Telegram path
 * is exercised against api.telegram.org for real in the existing
 * verification script — here we just stub `fetch` to control its outcome
 * deterministically. The email path is gated by env vars so we manipulate
 * those rather than mocking nodemailer.
 */

describe('dispatch (Telegram → email fallback)', () => {
  let originalFetch: typeof fetch;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = {
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      ALERT_TELEGRAM_CHAT_ID: process.env.ALERT_TELEGRAM_CHAT_ID,
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS,
      ALERT_EMAIL_TO: process.env.ALERT_EMAIL_TO,
      ALERT_EMAIL_FROM: process.env.ALERT_EMAIL_FROM,
      EMAIL_FROM: process.env.EMAIL_FROM,
    };
    // Default: Telegram configured (so dispatchTelegram doesn't short-circuit on missing config)
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.ALERT_TELEGRAM_CHAT_ID = '12345';
    // Default: email NOT configured (so it falls back to "not configured" error)
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.ALERT_EMAIL_TO;
    delete process.env.ALERT_EMAIL_FROM;
    delete process.env.EMAIL_FROM;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns delivered+via=telegram on Telegram success', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const result = await dispatch(SAMPLE_ALERT);
    expect(result.delivered).toBe(true);
    expect(result.via).toBe('telegram');
  });

  it('skips email path when Telegram succeeds (even if email is configured)', async () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    process.env.ALERT_EMAIL_TO = 'alerts@dev.null';
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    global.fetch = fetchSpy;
    const result = await dispatch(SAMPLE_ALERT);
    expect(result.delivered).toBe(true);
    expect(result.via).toBe('telegram');
    // Only the Telegram fetch should have happened — no nodemailer transport opened.
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns delivered=false with combined error when both channels fail', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    // No email config → dispatchEmail returns "not configured"
    const result = await dispatch(SAMPLE_ALERT);
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('telegram:');
    expect(result.error).toContain('email:');
    expect(result.error).toContain('403');
    expect(result.error).toContain('not configured');
  });

  it('falls back to email and returns via=email when Telegram fails but email succeeds', async () => {
    // Telegram fails
    global.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    // Email is configured AND succeeds (mock nodemailer to short-circuit the SMTP call)
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    process.env.ALERT_EMAIL_TO = 'alerts@dev.null';
    vi.doMock('nodemailer', () => ({
      default: {
        createTransport: () => ({
          sendMail: vi.fn().mockResolvedValue({ messageId: '<test@local>' }),
          close: vi.fn(),
        }),
      },
    }));
    // Reset module cache so the dispatcher re-imports with our mock active.
    vi.resetModules();
    const { dispatch: freshDispatch } = await import('./dispatcher.js');
    const result = await freshDispatch(SAMPLE_ALERT);
    expect(result.delivered).toBe(true);
    expect(result.via).toBe('email');
    vi.doUnmock('nodemailer');
  });

  it('reports Telegram error when only Telegram fails (no email configured)', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const result = await dispatch(SAMPLE_ALERT);
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('500');
  });

  it('reports both errors when Telegram throws and email is unconfigured', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const result = await dispatch(SAMPLE_ALERT);
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('telegram: TypeError: fetch failed');
    expect(result.error).toContain('email: email fallback not configured');
  });
});

describe('emailConfig', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS,
      ALERT_EMAIL_TO: process.env.ALERT_EMAIL_TO,
      ALERT_EMAIL_FROM: process.env.ALERT_EMAIL_FROM,
      EMAIL_FROM: process.env.EMAIL_FROM,
    };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns null when any required var is missing', () => {
    delete process.env.SMTP_HOST;
    expect(emailConfig()).toBeNull();
  });

  it('returns config when all required vars set', () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    process.env.ALERT_EMAIL_TO = 'alerts@dev.null';
    const cfg = emailConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.port).toBe(587);
    expect(cfg!.from).toBe('u'); // falls back to SMTP_USER when EMAIL_FROM unset
  });

  it('prefers ALERT_EMAIL_FROM over EMAIL_FROM over SMTP_USER for from', () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    process.env.ALERT_EMAIL_TO = 'alerts@dev.null';
    process.env.EMAIL_FROM = 'env-from@x';
    process.env.ALERT_EMAIL_FROM = 'alert-from@x';
    expect(emailConfig()!.from).toBe('alert-from@x');
    delete process.env.ALERT_EMAIL_FROM;
    expect(emailConfig()!.from).toBe('env-from@x');
    delete process.env.EMAIL_FROM;
    expect(emailConfig()!.from).toBe('u');
  });

  it('returns null for non-numeric port', () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_PORT = 'not-a-number';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    process.env.ALERT_EMAIL_TO = 'alerts@dev.null';
    expect(emailConfig()).toBeNull();
  });
});
