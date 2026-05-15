/**
 * Routing guard — circuit breaker for agent-to-agent message delivery.
 *
 * Sits in front of `routeAgentMessage` and refuses sends that exceed
 * configured thresholds. Prevents the runaway loops we'd otherwise rely on
 * a human to spot. See fixes-md/runaway-agent-loops.md for the incident
 * report this was built to prevent.
 *
 * The guard is intentionally a tiny surface — one function. Keep it that way.
 */
export { checkAndRecordSend } from './guard.js';
export type { GuardDecision, GuardInput, BlockReason } from './guard.js';
