# OpenCode plugin

The entry `index.mjs` uses the official `@opencode-ai/plugin` `tool()` helper and the shared runtime schemas. The tool contract now includes seven tools: the existing `session_hub_sync/search/resolve/read` plus `session_hub_import/forge/open`. Native writers for 17 targets are being integrated with the original importer UI; the earlier context-transfer design has been withdrawn.

## Connection

Keep this adapter inside the complete session-import package: it imports `../runtime.cjs`. Add its absolute file URL to OpenCode's `plugin` array, retaining existing entries:

```json
{
  "plugin": ["file:///D:/path/to/session-import/hosts/opencode/index.mjs"]
}
```

Use a properly escaped file URL for paths with spaces or non-ASCII characters. The package's SDK dependency is isolated in `hosts/opencode/package.json`; other harnesses do not require it. If the SDK is not already resolvable from the package, install only this adapter's dependencies when preparing OpenCode integration:

```text
npm install --prefix <absolute-package-root>/hosts/opencode
```

This is an integration instruction, not an operation performed by the plugin. No root dependency is required. To avoid SDK installation altogether, OpenCode can use the shared stdio server instead of this native plugin:

```json
{
  "mcp": {
    "session-import": {
      "type": "local",
      "command": ["node", "D:/path/to/session-import/hosts/mcp.cjs"],
      "environment": { "SESSION_IMPORT_HOST": "opencode" },
      "enabled": true
    }
  }
}
```

Choose one transport to avoid exposing duplicate tools. `session_hub_open` opens the original importer panel, retaining automatic sync, source GUI titles and preview. Its destination fields are `target`, `root`, `workspace` and `placement`; the import tool uses `targetRoot` for the root field.

`session_hub_import` with `target: opencode` creates a real native session, writes complete history message by message and registers the destination workspace/sidebar. It returns session IDs, paths and import receipts instead of injecting a transcript into the current conversation. Open the returned session in the target client to continue chatting. Historical tool content is preserved without replaying execution. Large PI-Desktop histories use native fallback without clipping.

The original PI Forge remains available. Cross-host `session_hub_forge` supplies material and instructions for the current host model to distill; `content` and `outputPath` save the resulting rules or skills.

Real installation, import, sidebar visibility and continued chat are unverified. Historical tests cover only the older source parsing and PI paths. The old `.piplug` has not been updated and does not represent the current checkout. The connection examples above were not executed in this documentation update; no checks, model calls, installation or real imports were run.

Runtime instances use the active tool directory and close on `server.instance.disposed`.

References: https://opencode.ai/docs/plugins/ and https://opencode.ai/docs/custom-tools/. Hook signatures and disposal event were read from the official `v1.2.27` source (`packages/plugin/src/index.ts`, `packages/sdk/js/src/gen/types.gen.ts`).
