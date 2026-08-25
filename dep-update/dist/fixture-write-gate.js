// @bun
// extensions/fixture-write-gate.ts
var EDIT_TOOLS = { edit: true, write: true };
var FIXTURE = /(?:^|\/)\.project-setup\/(?:answers|sources)\.toml$/i;
var DENY_REASON = "blocked by dep-update (project-setup owns its answer fixtures): `.project-setup/answers.toml` and " + "`.project-setup/sources.toml` record the frozen bootstrap the project-setup runner poured, and that runner " + "is their only writer. dep-update reads them for baseline pins and drift notes; it never writes them. " + "To move a baseline, re-run project-setup with `--refresh`. To record a bump, apply it with the `dep_apply` " + "tool so the real manifest and lockfile change instead.";
function targetPaths(input) {
  const out = [];
  for (const key of ["path", "file_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0)
      out.push(value);
  }
  const { paths } = input;
  if (Array.isArray(paths)) {
    for (const p of paths) {
      if (typeof p === "string" && p.length > 0)
        out.push(p);
    }
  }
  return out;
}
function isFixturePath(raw) {
  return FIXTURE.test(raw.replaceAll("\\", "/").trim());
}
function decideToolCall(toolName, input) {
  if (!EDIT_TOOLS[toolName])
    return;
  if (!targetPaths(input).some(isFixturePath))
    return;
  return { block: true, reason: DENY_REASON };
}
function fixtureWriteGate(pi) {
  pi.on("tool_call", (event) => {
    try {
      return decideToolCall(event.toolName, event.input);
    } catch {
      return;
    }
  });
}
export {
  targetPaths,
  isFixturePath,
  fixtureWriteGate as default,
  decideToolCall,
  DENY_REASON
};
