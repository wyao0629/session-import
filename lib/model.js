"use strict";

/**
 * Unified session model for session-import 2.0.
 *
 * All harness modules return Entry[] from scan() and Message[] from messages().
 * The import pipeline consumes Message[] and produces the host's import shape.
 */

// ---------------------------------------------------------------------------
// Entry — one session in the index
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Entry
 * @property {string}  harness          Harness id (e.g. "codex", "kimi-code")
 * @property {string}  sessionId        Stable id within the harness
 * @property {string}  sessionPath      Canonical file/db path (+ "#anchor" when needed)
 * @property {string}  [title]          Short display name (<= 200 code-points)
 * @property {string}  [name]           Full name (may be longer than title)
 * @property {string}  [firstPrompt]    First non-injected user text, first 200 chars
 * @property {string}  [importSource]   Source id declared in manifest sessionSources (null = not importable)
 * @property {string}  [workspaceName]  Human-readable project/workspace name
 * @property {string}  [workspacePath]  Absolute project path, used for project binding
 * @property {string}  [modelId]        Last-known model identifier
 * @property {number}  [messageCount]   Approximate visible message count
 * @property {string}  [createdAt]      RFC3339
 * @property {string}  [updatedAt]      RFC3339
 * @property {boolean} [archived]       True when harness marks the session archived
 * @property {boolean} [internal]       True for sessions never shown in the harness GUI
 * @property {boolean} visible          Whether this entry should be shown in lists (default true)
 * @property {string}  [hiddenReason]   "subagent"|"archived"|"internal"|"empty"|"deleted"|null
 * @property {string}  nameKind         "native"|"generated"|"prompt"|"none"
 * @property {boolean} importable       Derived: importSource != null && harness.capabilities.import
 * @property {string}  [parentSessionId]  Parent entry's sessionId (for subagent threads)
 * @property {number}  [childCount]     Number of direct child sessions
 * @property {Object}  [importedFrom]   {source, externalId} if this PI-Desktop session was imported
 */

/**
 * Create a minimal valid Entry with sensible defaults.
 * @param {Partial<Entry>} fields
 * @returns {Entry}
 */
function makeEntry(fields) {
  return {
    visible: true,
    nameKind: "none",
    importable: false,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// Message — one message in a session
// ---------------------------------------------------------------------------

/**
 * @typedef {"user"|"assistant"|"system"} Role
 * @typedef {"normal"|"injected"|"noise"|"summary"|"subagent"|"error"} MessageKind
 * @typedef {"success"|"error"|"pending"} ToolStatus
 */

/**
 * @typedef {Object} ToolCall
 * @property {string}     id       Tool call id (uuid or harness-specific)
 * @property {string}     name     Tool name
 * @property {*}          [args]   Parsed arguments
 * @property {*}          [result] Parsed result
 * @property {ToolStatus} status
 */

/**
 * @typedef {Object} ChildRef
 * @property {string} harness
 * @property {string} sessionId
 * @property {string} [label]
 */

/**
 * @typedef {Object} Message
 * @property {Role}        role
 * @property {MessageKind} kind       Default "normal"
 * @property {string}      text       Plain text content (may be empty)
 * @property {string[]}    [thinking] Reasoning/thinking blocks (each is a string)
 * @property {string[]}    [images]   Base64 data-URIs or placeholder strings
 * @property {ToolCall[]}  [tools]    Tool calls attached to this message
 * @property {ChildRef[]}  [children] Sub-agent session references
 * @property {string}      [createdAt] RFC3339
 */

/**
 * Create a minimal valid Message.
 * @param {Partial<Message>} fields
 * @returns {Message}
 */
function makeMessage(fields) {
  return {
    role: "user",
    kind: "normal",
    text: "",
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// HarnessCapabilities
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} HarnessCapabilities
 * @property {boolean} import        Messages can be imported into PI-Desktop
 * @property {boolean} nativeInHost  Host already lists these sessions natively
 * @property {boolean} children      Sessions may have child (subagent) sessions
 */

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { makeEntry, makeMessage };
