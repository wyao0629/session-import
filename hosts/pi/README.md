# Pi extension

The original importer UI is reused while native writers for 17 targets are being integrated. The previous context-transfer design has been withdrawn. Real installation, import, sidebar visibility and continued chat remain unverified.

Load the existing checkout without installing a dependency (instructions only; not executed in this documentation update):

```text
pi -e <absolute-package-root>/hosts/pi/index.js
```

Alternatively add this metadata to the root `package.json`, preserving other fields, then use `pi install <absolute-package-root>`:

```json
{
  "pi": {
    "extensions": ["./hosts/pi/index.js"],
    "skills": ["./skills/session-import"]
  }
}
```

The extension imports `../runtime.cjs` relative to its own file. The scoped `package.json` marks only this adapter as ESM; it does not change the root package's module type.

## Usage

```text
/session-import-open
/session-hub sync
/session-hub search {"query":"project name"}
/session-import <full session key>
/session-import {"ref":"<key>","harness":"codex","workspace":"D:/workspace/my-project","placement":"workspace","includeSubagents":true}
/session-import-current <full session key>
/session-hub forge {"refs":["<key>"],"goal":"Extract project conventions"}
```

Seven tools share the runtime schemas: the existing `session_hub_sync/search/resolve/read` plus `session_hub_import/forge/open`. `open` opens the original importer panel with automatic sync, source GUI titles and preview. The panel exposes `target`, `root`, `workspace` and `placement`; the import tool names the root parameter `targetRoot`.

`import` writes each complete historical message into a real target-native session, registers its destination workspace/sidebar and returns a receipt containing the session ID and path. It does not insert a transcript into the current conversation. Tool history and readable thinking are preserved as historical content, without replaying tool execution. Large PI-Desktop histories use native fallback without clipping.

`/session-import` waits for idle, imports with `target: pi`, then opens the returned `sessionPath` with `ctx.switchSession`. With no arguments it opens the original panel. `/session-import-current` is a compatibility alias for the same native import-and-open operation; it no longer injects history into the current context. Direct tool calls and `/session-hub import` return the receipt without automatically switching sessions.

The original PI Forge is retained. Cross-host `session_hub_forge` provides source material and instructions for the current host model to distill; `content` and `outputPath` save the resulting rules or skills.

The runtime starts on `session_start`, retains the active workspace, and closes on `session_shutdown`. `SESSION_IMPORT_DATA_DIR` and `SESSION_IMPORT_AUTO_SYNC` are handled by the common runtime.

Current integration details are documented in `../README.md`. Historical tests cover only the older source parsing and PI paths, not this native integration. The old `.piplug` has not been updated and does not represent this checkout. No checks, model calls, installation or real imports were run for this documentation update.
