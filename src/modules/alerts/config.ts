/**
 * Thresholds and dispatch configuration for the alert daemon.
 *
 * All env-driven so operators can tune without a code change. Reasonable
 * defaults — chosen so a normal day produces zero alerts but the May 10
 * runaway pattern (and similar) trips within minutes.
 *
 * Env vars:
 *   COST_CAP_USD_DAILY           default $50.00 — cost spike when day-to-date exceeds
 *   ROUTING_BURST_THRESHOLD      default 5 — blocks per pair to trigger burst alert
 *   ROUTING_BURST_WINDOW_MS      default 5min
 *   AGENT_REGRESSION_MIN_RECENT  default 3 — agent must have spawned ≥ this many
 *                                times in regression-recent-window before silence counts
 *   AGENT_REGRESSION_RECENT_DAYS default 7
 *   AGENT_REGRESSION_SILENT_HOURS default 24 — silent this long → alert
 *   ALERT_COOLDOWN_HOURS         default 1 — minimum gap between same (type, pair) alerts
 *   ALERT_TELEGRAM_CHAT_ID       Telegram chat ID to send to (no default — empty disables dispatch)
 *   TELEGRAM_BOT_TOKEN           reused from existing config; needed for dispatch
 *   ALERTS_DISABLED              "1" to skip checks and dispatch entirely (debug)
 */

export interface AlertThresholds {
  costCapUsdDaily: number;
  routingBurstThreshold: number;
  routingBurstWindowMs: number;
  agentRegressionMinRecent: number;
  agentRegressionRecentDays: number;
  agentRegressionSilentHours: number;
  cooldownHours: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  costCapUsdDaily: 50,
  routingBurstThreshold: 5,
  routingBurstWindowMs: 5 * 60 * 1000,
  agentRegressionMinRecent: 3,
  agentRegressionRecentDays: 7,
  agentRegressionSilentHours: 24,
  cooldownHours: 1,
};

function numFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadThresholds(): AlertThresholds {
  return {
    costCapUsdDaily: numFromEnv('COST_CAP_USD_DAILY', DEFAULT_THRESHOLDS.costCapUsdDaily),
    routingBurstThreshold: numFromEnv('ROUTING_BURST_THRESHOLD', DEFAULT_THRESHOLDS.routingBurstThreshold),
    routingBurstWindowMs: numFromEnv('ROUTING_BURST_WINDOW_MS', DEFAULT_THRESHOLDS.routingBurstWindowMs),
    agentRegressionMinRecent: numFromEnv('AGENT_REGRESSION_MIN_RECENT', DEFAULT_THRESHOLDS.agentRegressionMinRecent),
    agentRegressionRecentDays: numFromEnv('AGENT_REGRESSION_RECENT_DAYS', DEFAULT_THRESHOLDS.agentRegressionRecentDays),
    agentRegressionSilentHours: numFromEnv(
      'AGENT_REGRESSION_SILENT_HOURS',
      DEFAULT_THRESHOLDS.agentRegressionSilentHours,
    ),
    cooldownHours: numFromEnv('ALERT_COOLDOWN_HOURS', DEFAULT_THRESHOLDS.cooldownHours),
  };
}

export function alertsDisabled(): boolean {
  return process.env.ALERTS_DISABLED === '1';
}

export function dispatchConfig(): { chatId: string; botToken: string } | null {
  const chatId = process.env.ALERT_TELEGRAM_CHAT_ID ?? '';
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (!chatId || !botToken) return null;
  return { chatId, botToken };
}
