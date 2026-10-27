// cad-viewer preview gallery: one version's renders, viewer captures, drawings, and concept
// screenshots, read from /api/gallery. Read-only: every image and PDF comes from /gallery/file,
// which serves only files inside the open project's hw/. Each tile shows its absolute path.

const $ = (id) => document.getElementById(id);
const COPIED_MS = 1500;

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

function setStatus(text, kind = "ok") {
  $("status").textContent = text;
  document.body.dataset.state = kind;
}

const tone = (status) => (status === "pass" ? "pass" : status === "fail" ? "fail" : "warn");
const when = (iso) => iso.replace("T", " ").replace("Z", " UTC");

async function copyPath(button, code) {
  try {
    await navigator.clipboard.writeText(code.textContent);
    button.textContent = "Copied";
  } catch {
    getSelection().selectAllChildren(code); // the path stays selected for Cmd/Ctrl+C
    button.textContent = "Selected";
  }
  setTimeout(() => (button.textContent = "Copy path"), COPIED_MS);
}

function pathRow(path, label) {
  const code = el("code", { class: "path", text: path });
  const button = el("button", {
    type: "button", class: "button button-ghost button-small", text: "Copy path",
    "aria-label": `Copy the path of ${label}`, onclick: (event) => copyPath(event.currentTarget, code),
  });
  return el("div", { class: "path-row" }, code, button);
}

function fact(key, value, factTone) {
  return el("li", { class: "fact", dataset: factTone ? { tone: factTone } : undefined },
    el("span", { class: "fact-key", text: `${key}: ` }), value);
}

// Two entries or fewer show inline; a longer list folds into a disclosure that names its count.
function folded(summary, lines, factTone) {
  const items = lines.map((line) => el("li", { text: line }));
  if (lines.length <= 2) return el("ul", { class: "facts", dataset: factTone ? { tone: factTone } : undefined }, items);
  return el("details", { class: "materials", dataset: factTone ? { tone: factTone } : undefined },
    el("summary", { text: `${summary}, ${lines.length}` }), el("ul", {}, items));
}

function materials(rows) {
  if (!rows?.length) return null;
  return folded("Materials per PN",
    rows.map((m) => `${m.pn} · ${m.label || "unlabelled"} (${m.rule || "no rule"})`));
}

function warnings(lines) {
  if (!lines?.length) return null;
  if (lines.length === 1) return el("ul", { class: "facts" }, fact("Warning", lines[0], "warn"));
  return folded("Warnings", lines, "warn");
}

function facts(tile) {
  const rows = [];
  if (tile.failures?.length) rows.push(fact("Failures", tile.failures.join(", "), "fail"));
  if (tile.retry) {
    const attempts = `${tile.retry.attempts} attempt${tile.retry.attempts === 1 ? "" : "s"}`;
    rows.push(fact("Retry", `${tile.retry.strategy}, ${attempts}${tile.retry.note ? ` — ${tile.retry.note}` : ""}`));
  }
  if (tile.subject?.length) rows.push(fact("Shows", tile.subject.join(", ")));
  if (tile.scale) rows.push(fact("Scale", String(tile.scale)));
  if (tile.projection) rows.push(fact("Projection", tile.projection));
  if (tile.note) rows.push(fact("Note", tile.note, "warn"));
  if (tile.version_recorded === false) rows.push(fact("Version", "not recorded; listed for every version", "warn"));
  rows.push(fact("Modified", when(tile.modified)));
  return el("ul", { class: "facts" }, rows);
}

function tileNode(section, tile, version) {
  const label = `${section.title.toLowerCase()} ${tile.title}`;
  const pdf = tile.pdf
    ? [el("a", { class: "tile-link", href: tile.pdf.url, target: "_blank", rel: "noopener", text: "Open PDF" }),
       pathRow(tile.pdf.path, `the PDF of ${label}`)]
    : section.id === "drawings" ? [el("p", { class: "empty", text: "No PDF beside this preview." })] : [];
  return el("li", { class: "tile" },
    el("a", { class: "tile-image", href: tile.url, target: "_blank", rel: "noopener",
              "aria-label": `Open ${label} full size` },
      el("img", { src: tile.url, alt: `${section.title}: ${tile.title}, ${version}`, loading: "lazy" })),
    el("div", { class: "tile-body" },
      el("div", { class: "tile-head" },
        el("span", { class: "tile-title", text: tile.title }),
        tile.status ? el("span", { class: "pill", dataset: { tone: tone(tile.status) }, text: tile.status }) : null),
      facts(tile),
      warnings(tile.warnings),
      materials(tile.materials),
      pdf,
      pathRow(tile.path, label)));
}

function sectionNode(section, version) {
  const heading = `gallery-${section.id}`;
  return el("section", { class: "gallery-section", "aria-labelledby": heading },
    el("h2", { id: heading, text: `${section.title} · ${section.tiles.length}` }),
    el("p", { class: "check-detail section-source", text: section.source }),
    section.notes.map((note) => el("p", { class: "check-detail", text: note })),
    section.tiles.length
      ? el("ul", { class: "tiles" }, section.tiles.map((tile) => tileNode(section, tile, version)))
      : el("p", { class: "empty", text: section.empty }));
}

function render(model) {
  document.title = `${model.product} ${model.version} · cad-viewer gallery`;
  $("product").textContent = `${model.product} previews`;
  $("badge").textContent = model.version;
  $("hw").textContent = model.hw;
  const select = $("version");
  select.replaceChildren(...model.versions.map((v) =>
    el("option", { value: v, selected: v === model.version, text: v === model.latest ? `${v} (latest)` : v })));
  const link = $("viewer-link");
  link.href = model.viewer.url;
  link.textContent = model.viewer.showing ? `Live 3D viewer · ${model.viewer.showing}` : "Live 3D viewer";
  $("sections").replaceChildren(...model.sections.map((section) => sectionNode(section, model.version)));
  const count = model.sections.reduce((n, s) => n + s.tiles.length, 0);
  setStatus(`${count} file${count === 1 ? "" : "s"} for ${model.version}`);
}

async function load(version) {
  const select = $("version");
  select.disabled = true;
  $("gallery").setAttribute("aria-busy", "true");
  setStatus(`Loading ${version}…`, "loading");
  try {
    const response = await fetch(`/api/gallery?version=${encodeURIComponent(version)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    render(data);
  } catch (error) {
    setStatus(`Gallery unavailable: ${error.message}`, "error");
    $("sections").replaceChildren(el("p", { class: "empty" },
      `Nothing to show for ${version}. `,
      version === "latest" ? null : el("a", { class: "tile-link", href: "/gallery", text: "Open the latest version" })));
  } finally {
    select.disabled = select.options.length === 0;
    $("gallery").setAttribute("aria-busy", "false");
  }
}

$("version").addEventListener("change", (event) => {
  const version = event.currentTarget.value;
  history.pushState({ version }, "", `/gallery?version=${encodeURIComponent(version)}`);
  load(version);
});

window.addEventListener("popstate", () => load(new URLSearchParams(location.search).get("version") || "latest"));

load(new URLSearchParams(location.search).get("version") || "latest");
