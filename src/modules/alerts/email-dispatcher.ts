import nodemailer from 'nodemailer';

import { log } from '../../log.js';
import type { AlertRecord } from './store.js';
import { formatMessage } from './dispatcher.js';

/**
 * Email backup channel for alerts. Only used as a fallback when the primary
 * (Telegram) dispatch returns delivered=false — handles the exact case email
 * exists for, which is "Telegram itself is the thing that broke." We don't
 * send to both channels under normal conditions; one notification per alert.
 *
 * Configuration is env-gated. The dispatcher checks for the full set
 * before attempting send; if any are missing, the email path is silently
 * disabled and the original Telegram failure is recorded as-is. This lets
 * the module ship without forcing every operator to configure SMTP.
 *
 * Required env (all four):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 * Required envelope:
 *   ALERT_EMAIL_TO   (recipient address; multiple comma-separated allowed)
 *   ALERT_EMAIL_FROM (sender address; falls back to EMAIL_FROM, then SMTP_USER)
 */

export interface EmailDispatchConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  to: string;
  from: string;
}

export function emailConfig(): EmailDispatchConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const portRaw = process.env.SMTP_PORT?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const to = process.env.ALERT_EMAIL_TO?.trim();
  const fromRaw = process.env.ALERT_EMAIL_FROM?.trim() || process.env.EMAIL_FROM?.trim() || user;
  if (!host || !portRaw || !user || !pass || !to || !fromRaw) return null;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { host, port, user, pass, to, from: fromRaw };
}

const SUBJECT_PREFIX = {
  cost_spike: '[nanoclaw alert] cost cap exceeded',
  routing_burst: '[nanoclaw alert] routing-guard burst',
  agent_regression: '[nanoclaw alert] agent regression',
} as const;

export interface EmailDispatchResult {
  delivered: boolean;
  error?: string;
}

export async function dispatchEmail(alert: AlertRecord): Promise<EmailDispatchResult> {
  const cfg = emailConfig();
  if (!cfg) {
    return { delivered: false, error: 'email fallback not configured (SMTP_* or ALERT_EMAIL_TO missing)' };
  }
  const subject = SUBJECT_PREFIX[alert.triggerType];
  // The same text body the Telegram path uses — Markdown is fine in plain
  // email; readers handle the * and backticks visually without rendering.
  const body = formatMessage(alert);
  try {
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      // 465 = implicit TLS; 587 + STARTTLS = secure: false. Auto-detect.
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    await transport.sendMail({
      from: cfg.from,
      to: cfg.to,
      subject,
      text: body,
    });
    transport.close();
    return { delivered: true };
  } catch (err) {
    log.warn('alert email dispatch failed', {
      triggerType: alert.triggerType,
      err: String(err),
    });
    return { delivered: false, error: String(err).slice(0, 200) };
  }
}
