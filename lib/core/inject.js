"use strict";

/**
 * Injection / noise detection for session-import 2.0.
 *
 * Harnesses often prepend injected context to session files (AGENTS.md,
 * directory listings, tool manifests, etc.). This module identifies those
 * messages so the import pipeline can discard or fold them.
 */

// ---------------------------------------------------------------------------
// Common injection signatures
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  // PI / pi-desktop injections
  /^<pi-injection\b/i,
  /^\[Context injected by PI-Desktop\]/i,
  /^\[Session context\]/i,
  // Claude Code injections
  /^<parameter>human\b/i,
  /^<context>/i,
  /^\[Injected context\]/i,
  // Kimi cam-layer noise markers
  /^{"loop_control":/,
  /^{"cam_frame":/,
  // Generic harness metadata headers
  /^__SESSION_META__/,
  /^###\s+SYSTEM CONTEXT\b/i,
];

// Injected role indicators (harnesses that use a dedicated role)
const INJECTED_ROLES = new Set(["injection", "context", "system_context"]);

/**
 * Returns true if a message text looks like injected context rather than
 * genuine user or assistant content.
 * @param {string} text
 * @param {string} [role]
 * @returns {boolean}
 */
function isInjected(text, role) {
  if (role && INJECTED_ROLES.has(role)) return true;
  if (!text) return false;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Noise detection (user messages that carry no real intent)
// ---------------------------------------------------------------------------

const NOISE_PATTERNS = [
  // Kimi: undo/redo/empty turn markers
  /^{"op":"undo"/,
  /^{"op":"redo"/,
  /^{"loop_event":/, // loop control events
  // Empty or trivial content
  /^\s*$/,
];

/**
 * Returns true if the content is pure noise with no user intent.
 * @param {string} text
 * @param {string} [role]
 * @returns {boolean}
 */
function isNoise(text, role) {
  if (!text && role === "user") return true;
  if (!text) return false;
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Kimi-specific loop layer detection
// ---------------------------------------------------------------------------

/**
 * Returns true for Kimi cam/loop layer lines that should be filtered out
 * when reading at the ama (user-facing) layer.
 * @param {*} record
 * @returns {boolean}
 */
function isKimiLoopNoise(record) {
  if (!record || typeof record !== "object") return false;
  // cam layer control records
  if ("loop_control" in record || "cam_frame" in record || "loop_event" in record) return true;
  // origin.kind must be "user" for real user messages
  if (record.origin && record.origin.kind && record.origin.kind !== "user") return true;
  return false;
}

// ---------------------------------------------------------------------------
// pi-desktop: identify sessions imported by this plugin (never re-import)
// ---------------------------------------------------------------------------

/**
 * Returns true when a pi-desktop session entry was imported by this plugin
 * (to avoid circular re-import).
 * @param {import('../model').Entry} entry
 * @returns {boolean}
 */
function isPluginImported(entry) {
  return entry?.importedFrom?.source != null;
}

module.exports = { isInjected, isNoise, isKimiLoopNoise, isPluginImported };
