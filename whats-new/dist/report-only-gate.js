// @bun
// extensions/report-only-gate.ts
var EDIT_TOOLS = { edit: true, write: true };
var MANIFESTS = {
  "package.json": true,
  "cargo.toml": true,
  "pyproject.toml": true,
  "go.mod": true,
  "go.sum": true
};
var LOCKFILE = /\.lock$|^bun\.lock/;
var INSTALLER = /(?:^|[\s;&|(`])(?:(?:npm|pnpm|bun|yarn)\s+(?:install|add|up(?:grade)?|update)|pip3?\s+install|cargo\s+(?:add|install|update)|go\s+get|uv\s+(?:add|pip\s+install)|poetry\s+(?:add|update))\b/i;
var SKILL_READ = /^skill:\/\/whats-new(?:\/|$)|whats-new\/SKILL\.md/i;
var HANDOVER_READ = /^skill:\/\/dep-update(?:\/|$)|dep-update\/SKILL\.md/i;
var DENY_REASON = "blocked by whats-new (research-only): this session loaded the whats-new skill, which reports what changed " + "between two versions and changes nothing itself. Do not edit dependency manifests or lockfiles and do not " + "run installers or upgrade commands while researching -- the finding belongs in the report. If the user " + "actually wants the upgrade applied, that is dep-update's job: read `skill://dep-update` and run its " + "dep_scan/dep_apply confirm loop (reading it releases this gate).";
function createState() {
  return { armed: false };
}
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
function armsGate(raw) {
  return SKILL_READ.test(raw.replaceAll("\\", "/").trim());
}
function disarmsGate(raw) {
  return HANDOVER_READ.test(raw.replaceAll("\\", "/").trim());
}
function isDependencyFile(raw) {
  const path = raw.replaceAll("\\", "/").trim();
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return MANIFESTS[name] === true || LOCKFILE.test(name);
}
function decideToolCall(state, toolName, input) {
  if (toolName === "read") {
    for (const path of targetPaths(input)) {
      if (disarmsGate(path))
        state.armed = false;
      else if (armsGate(path))
        state.armed = true;
    }
    return;
  }
  if (!state.armed)
    return;
  if (EDIT_TOOLS[toolName]) {
    if (targetPaths(input).some(isDependencyFile))
      return { block: true, reason: DENY_REASON };
    return;
  }
  if (toolName === "bash") {
    const command = input.command;
    if (typeof command === "string" && INSTALLER.test(command)) {
      return { block: true, reason: DENY_REASON };
    }
  }
  return;
}
function reportOnlyGate(pi) {
  const state = createState();
  pi.on("session_start", () => {
    state.armed = false;
  });
  pi.on("tool_call", (event) => {
    try {
      return decideToolCall(state, event.toolName, event.input);
    } catch {
      return;
    }
  });
}
export {
  targetPaths,
  isDependencyFile,
  disarmsGate,
  reportOnlyGate as default,
  decideToolCall,
  createState,
  armsGate,
  DENY_REASON
};
