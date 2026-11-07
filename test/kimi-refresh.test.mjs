import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { refreshKimiCode, refreshAfterImport, waitForKimiIndex } = require('../hosts/native/kimi-refresh.cjs');

test('non-Windows platforms do not invoke a desktop refresh', async () => {
  let called = false;
  const result = await refreshKimiCode({ platform: 'linux', execute: async () => { called = true; } });
  assert.equal(result.status, 'unsupported');
  assert.equal(called, false);
});

test('Windows refresh requests the existing Kimi Code window without starting a process', async () => {
  let invocation;
  const result = await refreshKimiCode({ platform: 'win32', execute: async (command, args, options) => {
    invocation = { command, args, options };
    return { stdout: '{"status":"requested"}\n' };
  } });
  assert.equal(result.status, 'requested');
  assert.equal(invocation.command, 'powershell.exe');
  assert.ok(invocation.args.includes('-NoProfile'));
  assert.equal(invocation.options.windowsHide, true);
  assert.match(invocation.args.at(-1), /MainWindowTitle -eq 'Kimi Code'/);
  assert.match(invocation.args.at(-1), /SendWait\('\^r'\)/);
});

test('a missing Kimi Code window is reported without throwing', async () => {
  const result = await refreshKimiCode({ platform: 'win32', execute: async () => ({ stdout: '{"status":"not-running"}\n' }) });
  assert.equal(result.status, 'not-running');
});

test('desktop refresh failures are returned without failing the import', async () => {
  const result = await refreshKimiCode({ platform: 'win32', execute: async () => { throw new Error('desktop unavailable'); } });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'desktop unavailable');
});

test('only newly imported Kimi Code sessions trigger one two-stage refresh cycle per batch', async () => {
  let calls = 0;
  const result = await refreshAfterImport([
    { status: 'imported', target: 'kimi-code' },
    { status: 'imported', target: 'kimi-code' },
  ], {
    waitForIndex: async () => ({ status: 'indexed' }),
    refresh: async () => { calls += 1; return { status: 'requested' }; },
  });
  assert.equal(result.status, 'requested');
  assert.equal(calls, 2);
});

test('skipped imports and other targets do not refresh', async () => {
  let calls = 0;
  const refresh = async () => { calls += 1; return { status: 'requested' }; };
  assert.equal((await refreshAfterImport([{ status: 'skipped', target: 'kimi-code' }], { refresh })).status, 'not-needed');
  assert.equal((await refreshAfterImport([{ status: 'imported', target: 'codex' }], { refresh })).status, 'not-needed');
  assert.equal(calls, 0);
});

test('refresh triggers native index processing before reloading the latest interface', async () => {
  const events = [];
  const result = await refreshAfterImport([{ status: 'imported', target: 'kimi-code', sessionPath: 'C:/home/.kimi-code/sessions/wd_demo/new-session' }], {
    waitForIndex: async () => { events.push('indexed'); return { status: 'indexed' }; },
    refresh: async () => { events.push('refresh'); return { status: 'requested' }; },
  });
  assert.equal(result.status, 'requested');
  assert.deepEqual(events, ['refresh', 'indexed', 'refresh']);
});

test('index waiting observes the native dirty marker disappearing', async () => {
  let reads = 0;
  const result = await waitForKimiIndex([{ sessionPath: 'C:/home/.kimi-code/sessions/wd_demo/new-session' }], {
    readDir: async () => { reads += 1; return reads === 1 ? ['new-session.123'] : []; },
    intervalMs: 0,
  });
  assert.equal(result.status, 'indexed');
  assert.equal(reads, 2);
});

test('an unavailable window skips index waiting and the second refresh', async () => {
  let refreshCalls = 0, waitCalls = 0;
  const result = await refreshAfterImport([{ status: 'imported', target: 'kimi-code' }], {
    refresh: async () => { refreshCalls += 1; return { status: 'not-running' }; },
    waitForIndex: async () => { waitCalls += 1; return { status: 'indexed' }; },
  });
  assert.equal(result.status, 'not-running');
  assert.equal(refreshCalls, 1);
  assert.equal(waitCalls, 0);
});

test('index inspection failures still attempt the final refresh without throwing', async () => {
  let refreshCalls = 0;
  const result = await refreshAfterImport([{ status: 'imported', target: 'kimi-code' }], {
    refresh: async () => { refreshCalls += 1; return { status: 'requested' }; },
    waitForIndex: async () => { throw new Error('index unavailable'); },
  });
  assert.equal(result.status, 'requested');
  assert.equal(result.index, 'failed');
  assert.equal(result.indexError, 'index unavailable');
  assert.equal(refreshCalls, 2);
});
