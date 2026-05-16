import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import { runIngest } from './ingest.js';

/**
 * Periodic ingest cadence. Token-cost data isn't real-time-critical — the
 * dashboard is for trend-watching and the alert daemon (Phase 4) cares about
 * minute-scale anomalies, not second-scale. 60s keeps the load on sqlite
 * and the filesystem walk negligible while still surfacing a runaway
 * within ~1m of it starting.
 */
const SWEEP_INTERVAL_MS = 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function startTokenIngestSweep(): void {
  if (timer) return;
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  const tick = (): void => {
    try {
      const stats = runIngest(sessionsRoot);
      if (stats.rowsIngested > 0 || stats.filesWithNewLines > 0) {
        log.info('Token ingest sweep', { ...stats });
      }
    } catch (err) {
      // Non-fatal — log and keep the timer running so a transient sqlite
      // contention or filesystem hiccup doesn't take ingest down for good.
      log.error('Token ingest sweep failed', { err });
    }
  };
  // Kick off one run immediately so first-startup data appears without
  // waiting a full cycle, then settle into the periodic cadence.
  tick();
  timer = setInterval(tick, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive just for this sweep — orchestrator
  // shutdown should still happen cleanly.
  timer.unref?.();
}

export function stopTokenIngestSweep(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
