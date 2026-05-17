/**
 * Telegram polling watchdog.
 *
 * The Chat SDK polling loop retries on every failure with exponential
 * backoff, but two failure modes defeat it:
 *
 *   1. Frozen fetch — the TCP connection is half-open (Mac went to sleep,
 *      WiFi changed without a clean reset). The OS has not yet torn down
 *      the socket, so the in-flight getUpdates never throws; it just hangs.
 *      The polling loop is frozen, not retrying.
 *
 *   2. Slow recovery — after a prolonged outage the backoff is at its 30 s
 *      ceiling. When the network returns, the bot may sit silent for up to
 *      30 s while the loop sleeps through the remaining backoff window.
 *
 * The watchdog addresses both: it probes api.telegram.org/getMe on its own
 * interval. On an offline → online transition it calls onRestart(), which
 * tears down and re-inits the adapter. teardown() aborts the in-flight
 * fetch (fixing case 1) and setup() immediately starts a fresh polling
 * loop (fixing case 2).
 *
 * Design constraints:
 *   - We intentionally avoid reading private adapter state (pollingActive,
 *     pollingTask). The only public surface used is teardown + setup.
 *   - The watchdog never restarts while the network is healthy — it only
 *     acts on an offline → online edge, avoiding spurious churn.
 *   - Timer is unref'd so it doesn't keep the process alive by itself.
 */

import { log } from '../log.js';

export interface WatchdogConfig {
  botToken: string;
  /** How often to probe the Telegram API. Default: 60 000 ms. */
  probeIntervalMs?: number;
  /** Timeout for each getMe probe call. Default: 10 000 ms. */
  probeTimeoutMs?: number;
  /** Called when an offline → online edge is detected. Should teardown + re-setup the adapter. */
  onRestart: () => Promise<void>;
}

type NetworkState = 'unknown' | 'online' | 'offline';

export class TelegramPollingWatchdog {
  private readonly token: string;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly onRestart: () => Promise<void>;

  private state: NetworkState = 'unknown';
  private timer: ReturnType<typeof setInterval> | null = null;
  private restarting = false;
  private stopped = false;

  constructor(cfg: WatchdogConfig) {
    this.token = cfg.botToken;
    this.probeIntervalMs = cfg.probeIntervalMs ?? 60_000;
    this.probeTimeoutMs = cfg.probeTimeoutMs ?? 10_000;
    this.onRestart = cfg.onRestart;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.probe(), this.probeIntervalMs);
    // Don't prevent process exit when only the watchdog timer is pending.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    log.debug('Telegram watchdog started', { probeIntervalMs: this.probeIntervalMs });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.debug('Telegram watchdog stopped');
  }

  /** Exposed for tests to drive the probe cycle directly. */
  async probe(): Promise<void> {
    if (this.stopped || this.restarting) return;

    const reachable = await this.ping();

    // Re-check after the async ping: two concurrent probe() calls both pass
    // the initial guard before either ping resolves. The second one must
    // yield here rather than triggering a duplicate restart.
    if (this.stopped || this.restarting) return;

    if (reachable) {
      if (this.state === 'offline') {
        // Edge: offline → online. The polling loop may be frozen or sitting
        // in a long backoff window. Force a clean restart so polling resumes
        // immediately rather than waiting up to 30 s.
        log.info('Telegram watchdog: network recovered — restarting adapter');
        this.restarting = true;
        try {
          await this.onRestart();
          log.info('Telegram watchdog: adapter restarted successfully');
        } catch (err) {
          log.error('Telegram watchdog: restart failed', { err });
        } finally {
          this.restarting = false;
        }
      } else if (this.state === 'unknown') {
        log.debug('Telegram watchdog: initial probe OK');
      }
      this.state = 'online';
    } else {
      if (this.state !== 'offline') {
        // Edge: online/unknown → offline. Log once; subsequent failures are silent.
        log.warn('Telegram watchdog: API unreachable — will restart adapter on recovery');
        this.state = 'offline';
      }
    }
  }

  private async ping(): Promise<boolean> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/getMe`, {
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
