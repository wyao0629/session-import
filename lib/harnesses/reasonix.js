"use strict";
const { path, json, files, rows, fileOf, normalize, harness } = require("./_shared/other");
module.exports = harness({ id: "reasonix", label: "Reasonix", order: 71, roots: ["%APPDATA%/reasonix", "~/.reasonix"], markers: ["projects"],
  async enumerate(root) {
    const paths = await files(path.join(root, "projects"), (n, f) => n.endsWith(".jsonl") && !/\.(events|conflicts|updates)\.jsonl$/.test(n) && f.includes(path.sep + "sessions" + path.sep), 4);
    const out = [];
    for (const file of paths) {
      const meta = await json(file + ".meta", {}), stem = path.basename(file, ".jsonl");
      out.push({ sessionId: meta.id || stem, sessionPath: file, sourceFormat: "reasonix-jsonl", stem,
        subagent: path.basename(path.dirname(file)) === "subagents", parentSessionId: meta.parent_session_id ?? meta.parentSessionId,
        branchKind: stem.includes("-recovery-") ? "recovery" : undefined, dependencies: [file + ".meta"] });
    }
    for (const e of out.filter(e => e.branchKind === "recovery" && !e.parentSessionId)) {
      const prefix = e.stem.split("-recovery-")[0];
      const parent = out.filter(p => p !== e && !p.branchKind && !p.subagent && prefix.startsWith(p.stem)).sort((a,b) => b.stem.length-a.stem.length)[0];
      if (parent) e.parentSessionId = parent.sessionId;
    }
    // Recovery transcripts can repeat the same explore result; collapse them to
    // the original parent and only attach an unambiguous recorded child ID.
    const children = out.filter(e => e.subagent && !e.parentSessionId);
    const parents = new Map(children.map(e => [e.sessionId, new Set()]));
    for (const parent of out.filter(e => !e.subagent)) {
      for (const r of await rows(parent.sessionPath)) {
        if (r.role !== "tool" || typeof r.content !== "string") continue;
        for (const child of children) {
          if (path.dirname(path.dirname(child.sessionPath)) !== path.dirname(parent.sessionPath)) continue;
          if (r.content.includes(child.stem) || r.content.includes(child.sessionId)) parents.get(child.sessionId).add(parent.branchKind === "recovery" ? parent.parentSessionId || parent.sessionId : parent.sessionId);
        }
      }
    }
    for (const child of children) {
      const candidates = parents.get(child.sessionId);
      if (candidates.size === 1) child.parentSessionId = [...candidates][0];
      child.noCache = true;
    }
    return out;
  },
  async load(entry) {
    const file = fileOf(entry), meta = await json(file + ".meta", {});
    return { messages: normalize(await rows(file)), meta: { name: meta.topic_title, workspacePath: meta.workspace_root,
      modelId: meta.model, createdAt: meta.created_at, updatedAt: meta.updated_at } };
  }
});
