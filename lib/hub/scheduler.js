/**
 * Auto-sync scheduler. Runs `task` every `intervalMs` after the previous run
 * ended (never overlapping). setTimeout cannot exceed ~24.8 days, so long
 * intervals are waited out in capped slices. `lastRunAt` survives restarts, so
 * a plugin that was off longer than the interval syncs right after loading.
 */
"use strict";

const MAX_SLICE_MS = 12 * 3_600_000;

function createScheduler({ task, now = Date.now, setT = setTimeout, clearT = clearTimeout, onError = () => {} }) {
  let timer = null;
  let enabled = false;
  let intervalMs = 0;
  let lastRunAt = 0;
  let running = false;
  let nextRunAt = null;

  function clear() {
    if (timer) clearT(timer);
    timer = null;
    nextRunAt = null;
  }

  function arm() {
    clear();
    if (!enabled || running) return;
    const due = lastRunAt + intervalMs;
    const wait = Math.max(0, due - now());
    nextRunAt = due;
    timer = setT(tick, Math.min(wait, MAX_SLICE_MS));
  }

  async function tick() {
    timer = null;
    if (!enabled) return;
    if (now() < lastRunAt + intervalMs) return arm();
    running = true;
    try {
      await task();
    } catch (error) {
      onError(error);
    } finally {
      lastRunAt = now();
      running = false;
      arm();
    }
  }

  return {
    /** Apply a config; re-arms from the recorded last run time. */
    configure({ enabled: on, intervalMs: ms, lastRunAt: last }) {
      enabled = on === true;
      intervalMs = ms;
      if (typeof last === "number" && last > lastRunAt) lastRunAt = last;
      arm();
    },
    /** A sync that happened outside the schedule (manual) restarts the clock. */
    noteRun(at = now()) {
      lastRunAt = at;
      if (!running) arm();
    },
    stop() {
      enabled = false;
      clear();
    },
    state: () => ({ enabled, intervalMs, running, lastRunAt: lastRunAt || null, nextRunAt: enabled ? nextRunAt : null }),
  };
}

module.exports = { createScheduler, MAX_SLICE_MS };
