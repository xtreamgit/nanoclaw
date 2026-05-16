/**
 * Alerts — periodic threshold checker that pushes runaway / cost / health
 * alerts to the operator via Telegram. Sits on top of the data populated
 * by routing-guard (routing_blocks) and token-tracking (token_usage), plus
 * the sessions table for agent health.
 *
 * Three triggers (all configurable via env, all with cooldowns):
 *   - cost_spike: day-to-date USD spend exceeds COST_CAP_USD_DAILY ($50)
 *   - routing_burst: per-pair block count exceeds threshold inside window
 *   - agent_regression: previously-active agent has gone silent
 *
 * See config.ts for tuning. Wire into orchestrator startup via
 * `startAlertSweep()`.
 */
export { runAlertCycle, startAlertSweep, stopAlertSweep } from './sweep.js';
export { evaluate, checkCostSpike, checkRoutingBurst, checkAgentRegression } from './checks.js';
export { formatMessage } from './dispatcher.js';
export type { TriggerType, AlertRecord } from './store.js';
