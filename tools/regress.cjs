#!/usr/bin/env node
"use strict";

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { parseArgs } = require('node:util');
const registry = require('../lib/harnesses');
const { project } = require('../lib/import/project');
const { buildBatchMessage } = require('../lib/import/commit');
const { validateBatch } = require('../lib/import/contract');
const { yieldNow } = require('../lib/core/fsx');
const { values: args } = parseArgs({ options: { harness: { type: 'string' }, limit: { type: 'string', default: '0' }, out: { type: 'string' }, verbose: { type: 'boolean', default: false } } });
const limit = Number(args.limit);
if (!Number.isInteger(limit) || limit < 0) throw new Error('--limit must be a nonnegative integer');

async function run() {
  const selected = registry.list().filter((h) => !args.harness || h.id === args.harness);
  if (!selected.length) throw new Error('No matching harness');
  const results = [];
  for (const harness of selected) {
    const started = Date.now();
    const result = { harness: harness.id, roots: [], sessionCount: 0, visibleCount: 0, importableCount: 0, readCount: 0, contractPassCount: 0, contractFailCount: 0, emptyCount: 0, childCount: 0, errors: [], contractFailures: [] };
    const ctx = { home: os.homedir(), env: process.env, extraRoots: [], previous: new Map(), byPath: new Map(), yieldNow, report: (sessionId, error) => result.errors.push({ phase: 'scan', sessionId, error: String(error?.message ?? error) }) };
    let roots;
    try { roots = await harness.discover(ctx); }
    catch (error) { result.errors.push({ phase: 'discover', error: String(error.message ?? error) }); roots = []; }
    result.roots = roots.map((r) => r.root);
    const entries = new Map();
    for (const hit of roots) {
      if (args.verbose) console.log(`[${harness.id}] scan start`);
      try {
        for (const entry of await harness.scan(hit.root, ctx)) entries.set(entry.key ?? `${entry.harness}:${entry.sessionId}`, entry);
      } catch (error) { result.errors.push({ phase: 'scan', root: hit.root, error: String(error.message ?? error) }); }
    }
    result.scanDurationMs = Date.now() - started;
    if (args.verbose) console.log(`[${harness.id}] scan finished: ${entries.size} sessions in ${result.scanDurationMs}ms`);
    const readStarted = Date.now();
    const all = [...entries.values()];
    result.sessionCount = all.length;
    result.visibleCount = all.filter((e) => e.visible !== false).length;
    result.importableCount = all.filter((e) => e.importable).length;
    result.childCount = all.filter((e) => e.parentSessionId).length;
    const sample = limit ? all.slice(0, limit) : all;
    let attempted = 0;
    for (const entry of sample) {
      if (args.verbose) console.log(`[${harness.id}] read start ${++attempted}/${sample.length} ${entry.sessionId}`);
      try {
        const messages = await harness.messages(entry, { withThinking: true, roots: result.roots });
        result.readCount++;
        if (!messages.length) result.emptyCount++;
        if (entry.importable) {
          const converted = project(entry, messages);
          const session = { ...converted.session, messages: converted.messages.map(buildBatchMessage) };
          const errors = validateBatch({ source: entry.importSource, mode: 'skip', sessions: [session] });
          if (errors.length) { result.contractFailCount++; result.contractFailures.push({ sessionId: entry.sessionId, visible: entry.visible !== false, errors }); }
          else result.contractPassCount++;
        }
      } catch (error) { result.errors.push({ phase: 'messages', sessionId: entry.sessionId, error: String(error.message ?? error) }); }
      if (result.readCount % 50 === 0) {
        await yieldNow();
        if (args.verbose) console.log(`[${harness.id}] read ${result.readCount}/${sample.length}`);
      }
    }
    result.readDurationMs = Date.now() - readStarted;
    result.durationMs = Date.now() - started;
    results.push(result);
    console.log(`[${harness.id}] ${result.sessionCount} sessions; ${result.visibleCount} visible; ${result.readCount} read; ${result.contractPassCount} contract pass; ${result.contractFailCount} fail; ${result.errors.length} errors`);
    if (args.out) await save(results);
  }
  const summary = await save(results);
  console.log(JSON.stringify({ ...summary, results: undefined }));
  process.exitCode = summary.ok ? 0 : 1;
}

async function save(results) {
  const sum = (field) => results.reduce((count, r) => count + r[field], 0);
  const summary = { checkedAt: new Date().toISOString(), node: process.version, samplingLimit: limit, ok: results.every((r) => !r.errors.length && !r.contractFailCount), harnesses: results.length, totalSessions: sum('sessionCount'), visibleCount: sum('visibleCount'), totalImportable: sum('importableCount'), readCount: sum('readCount'), contractPassCount: sum('contractPassCount'), contractFailCount: sum('contractFailCount'), totalErrors: results.reduce((count, r) => count + r.errors.length, 0), results };
  if (args.out) { await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true }); await fs.writeFile(args.out, JSON.stringify(summary, null, 2), 'utf8'); }
  return summary;
}

run().catch((error) => { console.error(error.message); process.exitCode = 2; });
