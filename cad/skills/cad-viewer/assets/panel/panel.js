// cad-viewer side panel. State lives in the host: every button posts to /api/*, the host changes
// the OCP viewers through ocp_viewer's Python API, and the panel re-renders the state it returns.

const POLL_MS = 2000;
// The host's headless presenter opens the panel with ?audience=presenter; every other tab is the
// user's. Each audience has its own OCP viewers, as one viewer serves only its latest page.
const AUDIENCE = new URLSearchParams(location.search).get("audience") === "presenter" ? "presenter" : "user";
// The viewer page registers its websocket some time after its load event, and a push sent before
// that is lost. A user's tab announces twice, as the first delay was seen to fall short under
// SwiftShader load; the presenter announces once, and a capture re-announces it if its model is
// missing, so no late push lands in the middle of a capture.
const CONNECT_DELAYS_MS = AUDIENCE === "presenter" ? [1500] : [1500, 6000];

const $ = (id) => document.getElementById(id);
let state = null;
let lastJson = "";
let busy = false;
let refused = false; // the last action's error stays in the status line until the next action
const connectErrors = {}; // slot -> why its viewer did not get the model; kept until it does
const KEYS = ["A", "B"];
let versionList = null; // GET /api/versions, fetched again when the project or `latest` changes
let versionListFor = "";
let versionListError = null;
const wanted = {}; // version key -> the version picked while another request ran
const pickErrors = {}; // version key -> { message, selection } of the last pick that did not load
let loading = null; // { key, version } while a load-version request runs

async function api(route, body) {
  const options = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  const response = await fetch(route, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setStatus(text, kind = "ok") {
  $("status").textContent = text;
  document.body.dataset.state = kind;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

const fmt = (value, digits = 1) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "—";

function focusVersion() {
  if (!state) return null;
  return state.versions[state.active] || state.versions.A || null;
}

// ------------------------------------------------------------------------------- actions

async function act(button, route, body, pending = "Updating the viewer…") {
  if (busy) return null;
  busy = true;
  refused = false;
  button?.setAttribute("aria-busy", "true");
  setStatus(pending);
  try {
    accept(await api(route, body));
    showStatus();
    return null;
  } catch (error) {
    refused = true;
    setStatus(`Viewer host refused: ${error.message}`, "error");
    return error;
  } finally {
    button?.removeAttribute("aria-busy");
    busy = false;
    setTimeout(loadWanted); // a version picked during this request
  }
}

function partAction(action, target) {
  return (event) => act(event.currentTarget, "/api/parts", { action, target });
}

// ------------------------------------------------------------------------------- render

// "latest v3" for a key that follows new builds, else its vN
function shownName(key) {
  const selected = state.selected[key];
  return selected.version === "latest" ? `latest ${selected.label}` : selected.label;
}

function statusLine() {
  const version = focusVersion();
  if (!version) return "Nothing shown yet. Run viewer.py show <hw>.";
  const shown = state.mode === "split"
    ? `A ${shownName("A")} and B ${shownName("B")} side by side, camera synced`
    : `${shownName(state.versions[state.active] ? state.active : "A")} shown`;
  const anim = state.animation ? ` · animating ${state.animation.joint}` : "";
  return `${shown}${anim}`;
}

function showStatus() {
  const failed = Object.entries(connectErrors).map(([slot, message]) =>
    `Viewer ${slot.toUpperCase()} did not receive the model: ${message}`);
  if (failed.length) setStatus(failed.join(" · "), "error");
  else setStatus(statusLine());
}

function renderBar() {
  const version = focusVersion();
  const hasB = Boolean(state.versions.B);
  $("product").textContent = version ? version.product_id : "cad-viewer";
  $("badge").textContent = !version ? "—"
    : state.mode === "split" ? `${state.versions.A.label} | ${state.versions.B.label}` : version.label;
  $("show-a").setAttribute("aria-pressed", String(state.active === "A"));
  $("show-b").setAttribute("aria-pressed", String(state.active === "B"));
  $("show-b").disabled = !hasB;
  $("show-a").disabled = !version;
  $("show-a").textContent = state.versions.A ? `A ${state.versions.A.label}` : "A";
  $("show-b").textContent = hasB ? `B ${state.versions.B.label}` : "B";
  $("split").disabled = !hasB;
  $("split").setAttribute("aria-pressed", String(state.mode === "split"));
  const split = state.mode === "split";
  $("stage").dataset.mode = state.mode;
  $("figure-b").hidden = !split;
  $("caption-a").hidden = !split;
  if (split) {
    $("caption-a").textContent = `A · ${shownName("A")}`;
    $("caption-b").textContent = `B · ${shownName("B")}`;
    loadFrame("b");
  }
}

// ------------------------------------------------------------------------------- version pickers

const optionSignatures = {}; // version key -> the options its select lists, rebuilt only on change

const selectionKey = (selected) => (selected ? `${selected.version}|${selected.label}` : "");

const builtAt = (iso) => (iso ? iso.slice(0, 10) : "build time not recorded");

function previewCounts(previews) {
  const labels = { renders: "render set", captures: "capture", drawings: "drawing preview" };
  return Object.entries(labels).flatMap(([kind, label]) => {
    const count = previews?.[kind]?.length ?? 0;
    return count ? [`${count} ${label}${count === 1 ? "" : "s"}`] : [];
  });
}

function versionText(entry) {
  const counts = previewCounts(entry.previews);
  const preview = counts.length ? ` · ${counts.join(", ")}` : "";
  if (entry.error) return `${entry.label} · incomplete build${preview}`;
  const parts = entry.parts === null ? "" : ` · ${entry.parts} part${entry.parts === 1 ? "" : "s"}`;
  return `${entry.label} · ${builtAt(entry.built_utc)}${parts}${preview}`;
}
// [value, text] per option: latest (vN), then every built version, newest first
function versionOptions(selected) {
  if (!selected) return [["", "Nothing shown"]];
  const latest = versionList?.latest ?? state.latest;
  const options = [["latest", latest ? `latest (${latest})` : "latest"]];
  for (const entry of versionList?.versions ?? []) options.push([entry.label, versionText(entry)]);
  if (!options.some(([value]) => value === selected.label)) options.push([selected.label, selected.label]);
  return options;
}

function versionNote(key, selected) {
  if (loading?.key === key) return { text: `Loading ${loading.version}…` };
  if (key in wanted) return { text: `Loads ${wanted[key]} when the current update finishes.` };
  const failed = pickErrors[key];
  if (failed && failed.selection === selectionKey(selected)) return { text: failed.message, tone: "error" };
  if (selected?.error) return { text: selected.error, tone: "error" };
  if (versionListError) return { text: `Version list unavailable: ${versionListError}`, tone: "error" };
  if (selected?.version !== "latest") return { text: "" };
  return { text: state.latest && state.latest !== selected.label ? `Loading new build ${state.latest}…` : "Follows new builds." };
}

function renderVersions() {
  const shown = state?.versions.A;
  const visible = !shown ? ["A"] : state.mode === "split" ? KEYS : [state.versions[state.active] ? state.active : "A"];
  for (const key of KEYS) {
    const selected = state?.selected?.[key];
    const select = $(`version-${key}`);
    const note = $(`version-${key}-note`);
    $(`field-${key}`).hidden = !visible.includes(key);
    const options = versionOptions(selected);
    const signature = JSON.stringify(options);
    if (optionSignatures[key] !== signature) {
      optionSignatures[key] = signature;
      select.replaceChildren(...options.map(([value, text]) => el("option", { value, text })));
    }
    select.disabled = !selected;
    select.value = wanted[key] ?? (loading?.key === key ? loading.version : selected?.version) ?? "";
    const { text, tone } = versionNote(key, selected);
    note.textContent = text;
    note.hidden = !text;
    note.dataset.tone = tone ?? "";
    if (tone === "error") select.setAttribute("aria-invalid", "true");
    else select.removeAttribute("aria-invalid");
  }
}

async function refreshVersions() {
  const shown = state.versions.A;
  const wantedList = shown ? `${shown.hw}|${state.latest}` : "";
  if (wantedList === versionListFor) return;
  versionListFor = wantedList;
  try {
    versionList = shown ? await api("/api/versions") : null;
    versionListError = null;
  } catch (error) {
    versionList = null;
    versionListError = error.message;
    versionListFor = ""; // asked again on the next poll
  }
  renderVersions();
}

// One load-version at a time; a pick made meanwhile replaces any earlier pick for its key.
async function loadWanted() {
  const key = KEYS.find((k) => k in wanted);
  if (busy || !key) return;
  const version = wanted[key];
  delete wanted[key];
  const job = { key, version };
  loading = job;
  renderVersions();
  const error = await act($(`version-${key}`), "/api/load-version", { slot: key, version },
    `Loading ${version} into ${key}…`);
  if (loading === job) loading = null;
  if (error) pickErrors[key] = { message: `${version} did not load: ${error.message}`, selection: selectionKey(state.selected[key]) };
  else delete pickErrors[key];
  renderVersions();
}

function pickVersion(event) {
  const key = event.currentTarget.id.slice("version-".length);
  wanted[key] = event.currentTarget.value;
  renderVersions();
  loadWanted();
}

function renderCheck(version) {
  const box = $("check");
  box.replaceChildren();
  if (!version) return box.append(el("p", { class: "empty", text: "No version shown." }));
  const check = version.check;
  if (!check) {
    return box.append(el("p", { class: "empty", text: "No check result loaded. Pass --check CHECK.json to viewer.py show." }));
  }
  box.append(el("p", { class: "check-line" },
    el("span", { class: "pill", dataset: { tone: check.status === "pass" ? "pass" : "fail" }, text: check.status }),
    el("span", { text: `${version.label}, ${check.pose} pose` })));
  if (check.blocking_failures.length) {
    box.append(el("p", { class: "check-detail", text: `Blocking: ${check.blocking_failures.join(", ")}` }));
  }
  if (check.warnings.length) {
    box.append(el("p", { class: "check-detail", text: `Warnings: ${check.warnings.join(", ")}` }));
  }
}

function rowActions(id, label, members, view) {
  const hidden = members.every((pn) => view.hidden.includes(pn));
  const isolated = Array.isArray(view.isolated) && view.isolated.length === members.length
    && members.every((pn) => view.isolated.includes(pn));
  return {
    isolated,
    hidden,
    node: el("div", { class: "item-actions" },
      el("button", { type: "button", class: "button button-ghost button-small", "aria-pressed": String(hidden),
        "aria-label": `Hide ${label}`, dataset: { key: `hide-${id}` }, text: "Hide", onclick: partAction("hide", id) }),
      el("button", { type: "button", class: "button button-ghost button-small", "aria-pressed": String(isolated),
        "aria-label": `Isolate ${label}`, dataset: { key: `iso-${id}` }, text: "Iso", onclick: partAction("iso", id) })),
  };
}

function renderParts(version) {
  const groups = $("groups");
  const parts = $("parts");
  groups.replaceChildren();
  parts.replaceChildren();
  const view = state.view;
  $("ghost").setAttribute("aria-pressed", String(view.ghost));
  $("ghost").disabled = !version || !view.isolated;
  $("reset").disabled = !version;
  if (!version) {
    parts.append(el("li", { class: "empty", text: "Nothing shown yet." }));
    return;
  }
  if (!version.groups.length) groups.append(el("li", { class: "empty", text: "No subassemblies in assembly.yaml." }));
  for (const group of version.groups) {
    const actions = rowActions(group.id, group.id, group.parts, view);
    groups.append(el("li", { class: "item", dataset: { isolated: String(actions.isolated), hidden: String(actions.hidden) } },
      el("span", { class: "swatch", "aria-hidden": "true", style: "visibility: hidden" }),
      el("div", { class: "item-body" },
        el("p", { class: "item-name", text: group.id }),
        el("p", { class: "item-meta", text: `${group.title} · ${group.parts.length} part${group.parts.length === 1 ? "" : "s"}` })),
      actions.node));
  }
  for (const part of version.parts) {
    const actions = rowActions(part.ref, part.ref, [part.id], view);
    const findings = part.findings.map((f) => el("li", { class: "finding", dataset: { severity: f.severity } },
      el("span", { class: "finding-check", text: `${f.check}: ` }), f.message));
    parts.append(el("li", { class: "item", dataset: { isolated: String(actions.isolated), hidden: String(actions.hidden) } },
      el("span", { class: "swatch", "aria-hidden": "true", style: `background: ${part.colour}` }),
      el("div", { class: "item-body" },
        el("p", { class: "item-name", text: part.ref === part.pn ? `${part.pn} ${part.title}` : `${part.ref} · ${part.pn} ${part.title}` }),
        el("p", { class: "item-meta", text: `${part.material || "material not set"} · ${part.process || "process not set"}${part.group ? ` · ${part.group}` : ""}` }),
        findings.length ? el("ul", { class: "findings", "aria-label": `${part.ref} findings` }, findings) : null),
      actions.node));
  }
}

function renderMeasure(version) {
  const box = $("measure");
  box.replaceChildren();
  if (!version) return box.append(el("p", { class: "empty", text: "No metrics.json loaded." }));
  const totals = version.totals;
  const size = totals.bbox_mm ? totals.bbox_mm.size.map((v) => fmt(v, 1)).join(" × ") : "—";
  box.append(el("dl", { class: "totals" },
    el("div", { class: "total" }, el("dt", { text: "Mass" }), el("dd", { text: `${fmt(totals.mass_g, 1)} g` })),
    el("div", { class: "total" }, el("dt", { text: "Volume" }), el("dd", { text: `${fmt(totals.volume_mm3 / 1000, 1)} cm³` })),
    el("div", { class: "total" }, el("dt", { text: "Bbox mm" }), el("dd", { text: size }))));
  const head = el("tr", {}, el("th", { scope: "col", text: "Part" }), el("th", { scope: "col", text: "cm³" }),
    el("th", { scope: "col", text: "g / target" }), el("th", { scope: "col", text: "Bbox mm" }));
  const rows = version.parts.map((p) => {
    const m = p.metrics;
    const bbox = m.bbox_mm ? m.bbox_mm.size.map((v) => fmt(v, 0)).join("×") : "—";
    const target = m.mass_target_g === null ? "" : ` / ${fmt(m.mass_target_g, 0)}`;
    return el("tr", {}, el("th", { scope: "row", text: p.pn }), el("td", { text: fmt(m.volume_mm3 / 1000, 1) }),
      el("td", { text: `${fmt(m.mass_g, 1)}${target}` }), el("td", { text: bbox }));
  });
  box.append(el("table", { class: "measure-table" },
    el("caption", { text: `metrics.json, ${version.label}, zero pose` }),
    el("thead", {}, head), el("tbody", {}, rows)));
  renderHoles(box, version);
  if (totals.parts_without_density.length) {
    box.append(el("p", { class: "measure-note", text: `No density: ${totals.parts_without_density.join(", ")}` }));
  }
}

function holeText(hole) {
  const depth = hole.depth_mm === null ? "depth not listed" : `${fmt(hole.depth_mm, 1)} mm deep`;
  return `Ø${fmt(hole.diameter_mm, 1)} mm · ${hole.through ? "through" : "blind"} · ${depth}`;
}

function renderHoles(box, version) {
  const drilled = version.parts.filter((p) => p.metrics.holes.length);
  if (!drilled.length) {
    box.append(el("p", { class: "measure-note", text: "metrics.json lists no cylindrical bores for this version." }));
    return;
  }
  box.append(el("h3", { class: "list-heading", id: "holes-heading", text: "Cylindrical bores" }),
    el("ul", { class: "hole-list", "aria-labelledby": "holes-heading" }, drilled.map((p) =>
      el("li", { class: "hole-part" },
        el("p", { class: "hole-pn", text: `${p.pn} · ${p.metrics.holes.length} bore${p.metrics.holes.length === 1 ? "" : "s"}` }),
        el("ul", { class: "hole-rows", "aria-label": `${p.pn} cylindrical bores` },
          p.metrics.holes.map((h) => el("li", {}, el("span", { class: "hole-id", text: h.id }), holeText(h))))))));
}

function render() {
  const focused = document.activeElement?.dataset?.key;
  renderBar();
  renderVersions();
  const version = focusVersion();
  renderCheck(version);
  renderParts(version);
  renderMeasure(version);
  if (focused) document.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
}

function accept(next) {
  if (!next || !next.versions) return refresh();
  const json = JSON.stringify(next);
  state = next;
  if (json !== lastJson) {
    lastJson = json;
    render();
  }
  refreshVersions();
}

async function refresh() {
  try {
    accept(await api("/api/state"));
    if (!busy && !refused) showStatus();
  } catch (error) {
    setStatus(`Viewer host not answering: ${error.message}`, "error");
  }
}

// ------------------------------------------------------------------------------- viewer frames

const loaded = {};

function loadFrame(slot) {
  if (loaded[slot] || !state) return;
  loaded[slot] = true;
  const frame = $(`viewer-${slot}`);
  frame.addEventListener("load", () => {
    // OCP CAD Viewer does not replay its last model to a new page: ask the host to push it.
    for (const delay of CONNECT_DELAYS_MS) {
      setTimeout(() => api("/api/connected", { slot, audience: AUDIENCE })
        .then(() => { delete connectErrors[slot]; return refresh(); })
        .catch((e) => { connectErrors[slot] = e.message; if (!busy && !refused) showStatus(); }), delay);
    }
  });
  frame.src = state.slots[slot].urls[AUDIENCE];
}

// Focus inside a cross-origin viewer frame matches no selector here (:focus, :focus-within and
// :has(iframe:focus) all read false in Chromium) and fires no event on the iframe element; only
// the window's blur reports it, with the iframe as activeElement. Mark that figure for the ring,
// and keep reading while the window is blurred, as Tab can move on to the other frame.
let frameWatch = null;

function markFocusedFrame() {
  const active = document.activeElement;
  for (const figure of document.querySelectorAll(".viewer")) {
    figure.dataset.focused = String(active?.tagName === "IFRAME" && figure.contains(active));
  }
}

window.addEventListener("blur", () => {
  markFocusedFrame();
  frameWatch ??= setInterval(markFocusedFrame, 250);
});
window.addEventListener("focus", () => {
  clearInterval(frameWatch);
  frameWatch = null;
  markFocusedFrame();
});

async function start() {
  $("show-a").addEventListener("click", (e) => act(e.currentTarget, "/api/mode", { mode: state.mode, active: "A" }));
  $("show-b").addEventListener("click", (e) => act(e.currentTarget, "/api/mode", { mode: state.mode, active: "B" }));
  $("split").addEventListener("click", (e) =>
    act(e.currentTarget, "/api/mode", { mode: state.mode === "split" ? "single" : "split", active: state.active }));
  $("ghost").addEventListener("click", partAction("ghost"));
  $("reset").addEventListener("click", partAction("reset"));
  for (const key of KEYS) $(`version-${key}`).addEventListener("change", pickVersion);
  await refresh();
  if (state) {
    loadFrame("a");
    if (state.mode === "split") loadFrame("b");
    document.body.dataset.ready = "true";
  }
  setInterval(refresh, POLL_MS);
}

window.cadPanel = { refresh };
start();
