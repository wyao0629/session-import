'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { serialize, optionalBytes, parseJson, mergeJson, writeJsonl, prepare } = require('./common.cjs');

function defaultRoot({ home = os.homedir(), env = process.env } = {}) {
  return env.KIMI_HOME || path.join(home, '.kimi');
}

function samePath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function* contextRecords(messages) {
  let checkpoint = 0;
  for (const message of messages) {
    if (message.role === 'user') yield { role: '_checkpoint', id: checkpoint++ };
    yield { role: message.role, content: message.content };
  }
}

function* wireRecords(messages) {
  yield { type: 'metadata', protocol_version: '1.10' };
  let turnOpen = false, step = 0, lastTime;
  const event = (timestamp, type, payload) => ({ timestamp: timestamp / 1000, message: { type, payload } });
  for (const message of messages) {
    if (message.role === 'user') {
      if (turnOpen) yield event(lastTime, 'TurnEnd', {});
      yield event(message.time, 'TurnBegin', { user_input: message.content, origin: { kind: 'user' } });
      turnOpen = true;
      step = 0;
    } else {
      yield event(message.time, 'StepBegin', { n: ++step });
      yield event(message.time, 'ContentPart', { type: 'text', text: message.content });
    }
    lastTime = message.time;
  }
  if (turnOpen) yield event(lastTime, 'TurnEnd', {});
}

async function importSession({ entry, messages, destination, title, mode, options } = {}) {
  const prepared = prepare({ entry, messages, title });
  const root = path.resolve(destination.root || defaultRoot());
  const workspace = path.resolve(destination.workspace);
  const indexPath = path.join(root, 'kimi.json');
  const sessionId = randomUUID();
  const backupPath = path.join(root, '.session-import-backups', sessionId);
  let sessionPath;
  try {
    return await serialize(indexPath, async () => {
      const bytes = await optionalBytes(indexPath);
      const index = bytes === null ? {} : parseJson(bytes);
      const workDirs = index.work_dirs ?? [];
      if (!Array.isArray(workDirs)) throw new TypeError('kimi.json work_dirs must be an array');
      const existing = workDirs.find(item => (item.kaos ?? 'local') === 'local' && samePath(item.path, workspace));
      const nativeWorkspace = existing?.path ?? workspace;
      // Legacy uses MD5 of the original work-directory string, without case folding.
      const workDirId = createHash('md5').update(nativeWorkspace, 'utf8').digest('hex');
      const scope = path.join(root, 'sessions', workDirId);
      sessionPath = path.join(scope, sessionId);
      await fs.mkdir(scope, { recursive: true, mode: 0o700 });
      await fs.mkdir(sessionPath, { mode: 0o700 });
      await writeJsonl(path.join(sessionPath, 'context.jsonl'), contextRecords(prepared.messages));
      const wirePath = path.join(sessionPath, 'wire.jsonl');
      await writeJsonl(wirePath, wireRecords(prepared.messages));
      const wireStat = await fs.stat(wirePath);
      const state = {
        version: 1, approval: { yolo: false, afk: false, auto_approve_actions: [] },
        additional_dirs: [], custom_title: prepared.title, title_generated: true, title_generate_attempts: 0,
        plan_mode: false, plan_session_id: null, plan_slug: null, wire_mtime: wireStat.mtimeMs / 1000,
        archived: false, archived_at: null, auto_archive_exempt: false, todos: [],
        cwd: nativeWorkspace, createdAt: prepared.createdAt, updatedAt: prepared.updatedAt,
      };
      await fs.writeFile(path.join(sessionPath, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await mergeJson(indexPath, backupPath, current => {
        const directories = current.work_dirs ?? [];
        if (!Array.isArray(directories)) throw new TypeError('kimi.json work_dirs must be an array');
        if (!directories.some(item => (item.kaos ?? 'local') === 'local' && samePath(item.path, nativeWorkspace))) {
          directories.push({ path: nativeWorkspace, kaos: 'local', last_session_id: sessionId });
        }
        return { ...current, work_dirs: directories };
      });
      return { sessionId, sessionPath, target: 'kimi-legacy', title: prepared.title,
        messageCount: prepared.messages.length, nativeHistory: true,
        sidebar: { registered: true, workspace: nativeWorkspace, indexPath } };
    });
  } catch (cause) {
    const error = new Error('Kimi Legacy native import failed; partial files and index backups are retained', { cause });
    Object.assign(error, { code: cause.code ?? 'KIMI_LEGACY_IMPORT_FAILED', sessionId, sessionPath, backupPath });
    throw error;
  }
}

module.exports = { id: 'kimi-legacy', label: 'Kimi Legacy', defaultRoot, importSession };
