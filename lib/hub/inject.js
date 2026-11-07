/**
 * Harnesses prepend synthetic "user" messages (environment context, recalled
 * memories, AGENTS.md, slash-command transcripts). They are whole messages
 * wrapped in a tag, so they are recognised by their opening tag rather than by
 * a bare "<" - a real question that merely starts with "<" is kept.
 */
"use strict";

const KNOWN_TAGS = new Set(
  [
    "app-context",
    "environment_context",
    "user_instructions",
    "permissions",
    "instructions",
    "system-reminder",
    "relevant-memories",
    "model_switch",
    "codex_apps_client_time_context",
    "external_codex_apps_open_page",
    "recommended_plugins",
    "collaboration_mode",
    "turn_aborted",
    "skills_instructions",
    "plugins_instructions",
    "session_context",
    "local-command-caveat",
    "local-command-stdout",
    "command-name",
    "command-message",
    "command-args",
    "user-prompt-submit-hook",
  ].map((t) => t.toLowerCase()),
);

const OPEN_TAG = /^<([A-Za-z][\w-]*)[\s>]/;

function isInjected(text) {
  const t = String(text ?? "").trimStart();
  if (!t) return false;
  if (/^# AGENTS\.md/.test(t) || /^You are Codex[,. ]/.test(t)) return true;
  const m = OPEN_TAG.exec(t);
  if (!m) return false;
  const tag = m[1];
  if (KNOWN_TAGS.has(tag.toLowerCase())) return true;
  return /[-_]/.test(tag) && t.includes(`</${tag}>`);
}

/**
 * Codex wraps a request with attachment / referenced-chat headers and puts what
 * the user actually typed after "## My request:" (or "## My request for Codex:").
 * Returns that part, or the text unchanged when there is no such marker.
 */
function userRequest(text) {
  const t = String(text ?? "");
  const m = /^#{1,3} My request(?: for Codex)?:\s*$/im.exec(t);
  return m ? t.slice(m.index + m[0].length).trim() || t : t;
}

module.exports = { isInjected, userRequest };
