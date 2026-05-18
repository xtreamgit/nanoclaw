import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramPollingWatchdog } from './telegram-watchdog.js';

// Each test drives probe() directly instead of relying on real timers,
// so we don't need vi.useFakeTimers() — just stub global fetch.

const TOKEN = 'test-token-123';

function makeWatchdog(onRestart: () => Promise<void>) {
  return new TelegramPollingWatchdog({
    botToken: TOKEN,
    probeIntervalMs: 60_000,
    probeTimeoutMs: 5_000,
    onRestart,
  });
}

function stubFetch(ok: boolean) {
  const fn = vi.fn().mockResolvedValue({ ok } as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('TelegramPollingWatchdog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('healthy network', () => {
    it('does not call onRestart when the network has always been online', async () => {
      const onRestart = vi.fn().mockResolvedValue(undefined);
      const dog = makeWatchdog(onRestart);
      stubFetch(true);

      await dog.probe(); // unknown → online
      await dog.probe(); // online → online
      await dog.probe();

      expect(onRestart).not.toHaveBeenCalled();
    });
  });

  describe('offline → online recovery', () => {
    it('calls onRestart exactly once on the first successful probe after an outage', async () => {
      const onRestart = vi.fn().mockResolvedValue(undefined);
      const dog = makeWatchdog(onRestart);

      // Simulate outage
      stubFetch(false);
      await dog.probe(); // unknown → offline
      await dog.probe(); // offline, stays offline — no restart
      expect(onRestart).not.toHaveBeenCalled();

      // Network recovers
      stubFetch(true);
      await dog.probe(); // offline → online — triggers restart
      expect(onRestart).toHaveBeenCalledTimes(1);

      // Subsequent healthy probes do NOT re-trigger restart
      await dog.probe();
      await dog.probe();
      expect(onRestart).toHaveBeenCalledTimes(1);
    });

    it('does not call onRestart on the initial unknown → online probe', async () => {
      const onRestart = vi.fn().mockResolvedValue(undefined);
      const dog = makeWatchdog(onRestart);
      stubFetch(true);

      await dog.probe(); // unknown → online (startup, not a recovery)
      expect(onRestart).not.toHaveBeenCalled();
    });
  });

  describe('concurrent probe guard', () => {
    it('does not run a second probe while a restart is in progress', async () => {
      let restartStarted = false;
      let resolveRestart!: () => void;
      const restartLatch = new Promise<void>((res) => {
        resolveRestart = res;
      });
      const onRestart = vi.fn().mockImplementation(async () => {
        restartStarted = true;
        await restartLatch;
      });

      const dog = makeWatchdog(onRestart);

      // Drive to offline state
      stubFetch(false);
      await dog.probe();

      // Trigger recovery — onRestart will hang until we release the latch
      stubFetch(true);
      const firstProbe = dog.probe(); // starts restart

      // Wait until the restart is actually in progress (restarting = true)
      // before firing the second probe. This avoids a race where both probes
      // pass the initial guard before either ping() resolves.
      await vi.waitFor(() => expect(restartStarted).toBe(true));

      // Second probe fires while the first restart is still in progress
      await dog.probe(); // should return immediately (restarting guard)

      resolveRestart();
      await firstProbe;

      // onRestart should only have been called once
      expect(onRestart).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopped watchdog', () => {
    it('ignores probe calls after stop()', async () => {
      const onRestart = vi.fn().mockResolvedValue(undefined);
      const dog = makeWatchdog(onRestart);

      stubFetch(false);
      await dog.probe(); // offline

      dog.stop();

      stubFetch(true);
      await dog.probe(); // stopped, should be a no-op
      expect(onRestart).not.toHaveBeenCalled();
    });
  });

  describe('restart failure', () => {
    it('does not throw when onRestart rejects — watchdog remains operational', async () => {
      let calls = 0;
      const onRestart = vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) throw new Error('restart failed');
      });
      const dog = makeWatchdog(onRestart);

      // Go offline
      stubFetch(false);
      await dog.probe();

      // First recovery — onRestart throws, watchdog should survive
      stubFetch(true);
      await expect(dog.probe()).resolves.toBeUndefined();
      expect(onRestart).toHaveBeenCalledTimes(1);

      // After a failed restart the state is still 'online' (we accepted the recovery),
      // so a second consecutive online probe should NOT trigger another restart.
      await dog.probe();
      expect(onRestart).toHaveBeenCalledTimes(1);
    });
  });

  describe('probe uses correct URL and timeout', () => {
    it('calls the Telegram getMe endpoint for the configured bot', async () => {
      const fetchSpy = stubFetch(true);
      const dog = makeWatchdog(vi.fn());
      await dog.probe();

      expect(fetchSpy).toHaveBeenCalledWith(
        `https://api.telegram.org/bot${TOKEN}/getMe`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });
});
