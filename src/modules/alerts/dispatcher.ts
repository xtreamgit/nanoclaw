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
  /** Channel that successfully delivered, when delivered=true. */
  via?: 'telegram' | 'email';
  error?: string;
}

/**
 * Telegram-only send. Exported so the orchestrator (and tests) can hit it
 * directly; production callers should use `dispatch()` which adds the
 * email fallback. Uses raw HTTPS rather than the channel adapter so the
 * alert path:
 *   - has zero coupling to channel registration timing
 *   - survives if the channel adapter is temporarily broken
 *   - doesn't compete with normal Saul-DM traffic for adapter state
 */
export async function dispatchTelegram(alert: AlertRecord): Promise<DispatchResult> {
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
    return { delivered: true, via: 'telegram' };
  } catch (err) {
    log.warn('alert telegram dispatch failed', { triggerType: alert.triggerType, err: String(err) });
    return { delivered: false, error: String(err).slice(0, 200) };
  }
}

/**
 * Primary alert dispatch. Tries Telegram first; if that fails AND email is
 * configured (see email-dispatcher.ts for required env), falls back to
 * email. Returns a single combined result.
 *
 * Why primary/fallback rather than send-to-both: under normal conditions
 * one notification per alert is what the operator wants. Email is here
 * precisely for the case where Telegram is the thing that broke — so
 * sending email when Telegram succeeded would mostly just be noise.
 *
 * If both channels fail the error includes both diagnostics joined.
 */
export async function dispatch(alert: AlertRecord): Promise<DispatchResult> {
  const tg = await dispatchTelegram(alert);
  if (tg.delivered) return tg;

  // Telegram failed (no config, transient network, etc.) — try email if set up.
  // dispatchEmail returns {delivered:false, error:"not configured"} when the env
  // isn't set, which we surface as part of the combined error so the operator
  // can see why neither channel paged.
  const { dispatchEmail } = await import('./email-dispatcher.js');
  const em = await dispatchEmail(alert);
  if (em.delivered) {
    log.info('alert delivered via email fallback (telegram failed)', {
      triggerType: alert.triggerType,
      telegramError: tg.error,
    });
    return { delivered: true, via: 'email' };
  }

  return {
    delivered: false,
    error: `telegram: ${tg.error ?? 'unknown'} | email: ${em.error ?? 'unknown'}`,
  };
}
