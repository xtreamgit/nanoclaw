import { log } from '../../log.js';
import { dispatchConfig } from './config.js';
import type { AlertRecord } from './store.js';

/**
 * Build the user-facing alert text. Kept formatted but compact —
 * Telegram renders Markdown well, but we want the headline + the
 * three numbers that matter, no more.
 */
export function formatMessage(alert: AlertRecord): string {
  const p = alert.payload;
  switch (alert.triggerType) {
    case 'cost_spike':
      return [
        `🚨 *Cost cap exceeded*`,
        `Day-to-date spend: *$${p.spendUsd}*`,
        `Cap: $${p.capUsd}`,
        `Run \`nanoclaw-status\` for per-agent breakdown.`,
      ].join('\n');
    case 'routing_burst':
      return [
        `🚨 *Routing-guard burst*`,
        `Pair: *${p.sender}* → *${p.recipient}*`,
        `Blocked sends: *${p.blockedCount}* (threshold ${p.threshold})`,
        `Guard is suppressing the loop. Investigate before lifting overrides.`,
      ].join('\n');
    case 'agent_regression':
      return [
        `⚠️ *Agent regression*`,
        `Agent: *${p.agent}*`,
        `Was active ${p.recentSpawns}× in last ${p.recentWindowDays}d, silent for >${p.silenceThresholdHours}h`,
        `Last active: ${p.lastActive}`,
      ].join('\n');
  }
}

export interface DispatchResult {
  delivered: boolean;
  error?: string;
}

/**
 * Best-effort Telegram push using the existing bot token. We send via raw
 * HTTPS rather than the channel adapter so the alert path:
 *   - has zero coupling to channel registration timing
 *   - survives if the channel adapter is temporarily broken
 *   - doesn't compete with normal Saul-DM traffic for adapter state
 *
 * Failure is non-fatal — we log and record the error in alert_history so
 * the operator can see it later if alerts mysteriously stop arriving.
 */
export async function dispatch(alert: AlertRecord): Promise<DispatchResult> {
  const cfg = dispatchConfig();
  if (!cfg) {
    return { delivered: false, error: 'ALERT_TELEGRAM_CHAT_ID or TELEGRAM_BOT_TOKEN not set' };
  }
  const text = formatMessage(alert);
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { delivered: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { delivered: true };
  } catch (err) {
    log.warn('alert dispatch failed', { triggerType: alert.triggerType, err: String(err) });
    return { delivered: false, error: String(err).slice(0, 200) };
  }
}
