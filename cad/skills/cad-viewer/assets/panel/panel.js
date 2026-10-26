// cad-viewer side panel. State lives in the host: every button posts to /api/*, the host changes
// the OCP viewers through ocp_viewer's Python API, and the panel re-renders the state it returns.

const POLL_MS = 2000;
const CONNECT_DELAY_MS = 1500;

const $ = (id) => document.getElementById(id);
let state = null;
let lastJson = "";
let busy = false;

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

async function act(button, route, body) {
  if (busy) return;
  busy = true;
  button?.setAttribute("aria-busy", "true");
  setStatus("Updating the viewer…");
  try {
    accept(await api(route, body));
    setStatus(statusLine());
  } catch (error) {
    setStatus(`Viewer host refused: ${error.message}`, "error");
  } finally {
    button?.removeAttribute("aria-busy");
    busy = false;
  }
}

function partAction(action, target) {
  return (event) => act(event.currentTarget, "/api/parts", { action, target });
}

// ------------------------------------------------------------------------------- render

function statusLine() {
  const version = focusVersion();
  if (!version) return "Nothing shown yet. Run viewer.py show <hw>.";
  const shown = state.mode === "split"
    ? `A ${state.versions.A.label} and B ${state.versions.B.label} side by side, camera synced`
    : `${version.label} shown`;
  const anim = state.animation ? ` · animating ${state.animation.joint}` : "";
  return `${shown}${anim}`;
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
    $("caption-a").textContent = `A · ${state.versions.A.label}`;
    $("caption-b").textContent = `B · ${state.versions.B.label}`;
    loadFrame("b");
  }
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
    const actions = rowActions(part.pn, part.pn, [part.pn], view);
    const findings = part.findings.map((f) => el("li", { class: "finding", dataset: { severity: f.severity } },
      el("span", { class: "finding-check", text: `${f.check}: ` }), f.message));
    parts.append(el("li", { class: "item", dataset: { isolated: String(actions.isolated), hidden: String(actions.hidden) } },
      el("span", { class: "swatch", "aria-hidden": "true", style: `background: ${part.colour}` }),
      el("div", { class: "item-body" },
        el("p", { class: "item-name", text: `${part.pn} ${part.title}` }),
        el("p", { class: "item-meta", text: `${part.material || "material not set"} · ${part.process || "process not set"}${part.group ? ` · ${part.group}` : ""}` }),
        findings.length ? el("ul", { class: "findings", "aria-label": `${part.pn} findings` }, findings) : null),
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
  const withHoles = version.parts.some((p) => Array.isArray(p.metrics.holes) && p.metrics.holes.length);
  const head = el("tr", {}, el("th", { scope: "col", text: "Part" }), el("th", { scope: "col", text: "cm³" }),
    el("th", { scope: "col", text: "g / target" }), el("th", { scope: "col", text: "Bbox mm" }),
    withHoles ? el("th", { scope: "col", text: "Holes" }) : null);
  const rows = version.parts.map((p) => {
    const m = p.metrics;
    const bbox = m.bbox_mm ? m.bbox_mm.size.map((v) => fmt(v, 0)).join("×") : "—";
    const target = m.mass_target_g === null ? "" : ` / ${fmt(m.mass_target_g, 0)}`;
    return el("tr", {}, el("th", { scope: "row", text: p.pn }), el("td", { text: fmt(m.volume_mm3 / 1000, 1) }),
      el("td", { text: `${fmt(m.mass_g, 1)}${target}` }), el("td", { text: bbox }),
      withHoles ? el("td", { text: (m.holes || []).map((h) => (typeof h === "object" ? JSON.stringify(h) : String(h))).join(", ") }) : null);
  });
  box.append(el("table", { class: "measure-table" },
    el("caption", { text: `metrics.json, ${version.label}, zero pose` }),
    el("thead", {}, head), el("tbody", {}, rows)));
  if (!withHoles) box.append(el("p", { class: "measure-note", text: "metrics.json lists no holes for this version." }));
  if (totals.parts_without_density.length) {
    box.append(el("p", { class: "measure-note", text: `No density: ${totals.parts_without_density.join(", ")}` }));
  }
}

function render() {
  const focused = document.activeElement?.dataset?.key;
  renderBar();
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
}

async function refresh() {
  try {
    accept(await api("/api/state"));
    if (!busy) setStatus(statusLine());
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
    setTimeout(() => api("/api/connected", { slot }).then(refresh).catch((e) => setStatus(e.message, "error")),
      CONNECT_DELAY_MS);
  });
  frame.src = state.slots[slot].url;
}

async function start() {
  $("show-a").addEventListener("click", (e) => act(e.currentTarget, "/api/mode", { mode: state.mode, active: "A" }));
  $("show-b").addEventListener("click", (e) => act(e.currentTarget, "/api/mode", { mode: state.mode, active: "B" }));
  $("split").addEventListener("click", (e) =>
    act(e.currentTarget, "/api/mode", { mode: state.mode === "split" ? "single" : "split", active: state.active }));
  $("ghost").addEventListener("click", partAction("ghost"));
  $("reset").addEventListener("click", partAction("reset"));
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
