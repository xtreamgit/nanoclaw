import { log } from '../../log.js';
import { alertsDisabled, loadThresholds } from './config.js';
import { evaluate } from './checks.js';
import { dispatch } from './dispatcher.js';
import { isInCooldown, recordAlert } from './store.js';

/**
 * One pass: evaluate every check, dispatch any that pass cooldown.
 * Exported separately from sweep loop so tests can invoke a single
 * cycle deterministically.
 */
export async function runAlertCycle(): Promise<{ fired: number; suppressed: number; failed: number }> {
  if (alertsDisabled()) return { fired: 0, suppressed: 0, failed: 0 };
  const thresholds = loadThresholds();
  const candidates = evaluate(thresholds);
  const cooldownMs = thresholds.cooldownHours * 60 * 60 * 1000;
  let fired = 0;
  let suppressed = 0;
  let failed = 0;
  for (const alert of candidates) {
    if (isInCooldown(alert.triggerType, alert.pairKey, cooldownMs)) {
      suppressed++;
      continue;
    }
    const result = await dispatch(alert);
    recordAlert(alert, result);
    if (result.delivered) {
      fired++;
      log.info('Alert fired', {
        triggerType: alert.triggerType,
        pairKey: alert.pairKey,
        payload: alert.payload,
      });
    } else {
      failed++;
      log.warn('Alert evaluated but not delivered', {
        triggerType: alert.triggerType,
        pairKey: alert.pairKey,
        error: result.error,
      });
    }
  }
  return { fired, suppressed, failed };
}

/**
 * 60s sweep cadence — same as token-tracking. Alerts shouldn't fire faster
 * than that; the cooldown window is in hours regardless.
 */
const SWEEP_INTERVAL_MS = 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export function startAlertSweep(): void {
  if (timer) return;
  const tick = (): void => {
    runAlertCycle().catch((err) => {
      log.error('alert sweep cycle failed', { err });
    });
  };
  // Run one cycle immediately so startup-time conditions get caught right
  // away; then settle into the periodic cadence.
  tick();
  timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopAlertSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
