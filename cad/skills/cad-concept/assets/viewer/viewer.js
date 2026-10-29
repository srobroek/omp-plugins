// cad-concept viewer: renders concept scene variants side by side at their nominal joints.
// Frames match scripts/concept.py: Z up, mm, XYZ Euler degrees.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const DEG = Math.PI / 180;
const css = getComputedStyle(document.documentElement);
const token = (name) => css.getPropertyValue(name).trim();
const byId = (id) => document.getElementById(id);

const ui = {
  stage: byId("stage"),
  canvas: byId("view"),
  labels: byId("labels"),
  overlay: byId("overlay"),
  overlayTitle: byId("overlay-title"),
  overlayBody: byId("overlay-body"),
  status: byId("status"),
  title: byId("scene-title"),
  file: byId("scene-file"),
  picker: byId("scene-picker"),
  select: byId("scene-select"),
  notice: byId("notice"),
  live: byId("live"),
  variants: byId("variant-list"),
  shot: byId("screenshot"),
  fit: byId("fit-view"),
  shotResult: byId("shot-result"),
  partLabels: byId("toggle-part-labels"),
  groupLabels: byId("toggle-group-labels"),
};

class SceneError extends Error {}

// --- three.js setup ---------------------------------------------------------

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
const world = new THREE.Scene();
world.background = new THREE.Color(token("--color-canvas"));
world.add(new THREE.HemisphereLight(token("--color-sky"), token("--color-ground"), 1.6));
const sun = new THREE.DirectionalLight(token("--color-sky"), 2);
sun.position.set(0.6, -1, 1.4);
world.add(sun);
const camera = new THREE.PerspectiveCamera(32, 1, 1, 50000);
const controls = new OrbitControls(camera, ui.canvas);
controls.addEventListener("change", requestRender);

const palette = [1, 2, 3, 4, 5, 6].map((i) => new THREE.Color(token(`--color-part-${i}`)));
const edgeColor = new THREE.Color(token("--color-edge"));
const accentColor = new THREE.Color(token("--color-accent"));

const state = {
  file: null,
  scene: null,
  content: null,
  grid: null,
  variants: [],
  labels: [],
  selected: null,
  framed: false,
};

// --- scene build ------------------------------------------------------------

function makeGeometry(shape) {
  switch (shape.type) {
    case "box":
      return new THREE.BoxGeometry(...shape.size);
    case "sphere":
      return new THREE.SphereGeometry(shape.radius, 32, 16);
    case "cylinder":
      return new THREE.CylinderGeometry(shape.radius, shape.radius, shape.height, 40).rotateX(Math.PI / 2);
    case "capsule":
      if (shape.height < 2 * shape.radius) throw new SceneError(`capsule height ${shape.height} is below 2 x radius`);
      return new THREE.CapsuleGeometry(shape.radius, shape.height - 2 * shape.radius, 8, 24).rotateX(Math.PI / 2);
    default:
      throw new SceneError(`unknown shape type "${shape.type}"`);
  }
}

function makePart(node, color) {
  const geometry = makeGeometry(node.shape);
  const material = new THREE.MeshStandardMaterial({
    color: node.color ? new THREE.Color(node.color) : color,
    roughness: 0.7,
    metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geometry, material);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 30),
    new THREE.LineBasicMaterial({ color: edgeColor, transparent: true }),
  );
  mesh.add(edges);
  mesh.userData.edges = edges;
  return mesh;
}

function applyTransform(object, node) {
  object.position.fromArray(node.position ?? [0, 0, 0]);
  const [rx, ry, rz] = node.rotation ?? [0, 0, 0];
  object.rotation.set(rx * DEG, ry * DEG, rz * DEG, "XYZ");
}

function buildVariant(def, index) {
  const root = new THREE.Group();
  root.name = `variant:${def.id}`;
  const nodes = new Map();
  const meshes = [];
  const visit = (node, parentObject, parentId) => {
    if (nodes.has(node.id)) throw new SceneError(`variant ${def.id}: duplicate node id "${node.id}"`);
    const object =
      node.kind === "part" ? makePart(node, palette[meshes.length % palette.length]) : new THREE.Group();
    if (node.kind === "part") meshes.push(object);
    applyTransform(object, node);
    object.userData.variantId = def.id;
    object.userData.nodeId = node.id;
    parentObject.add(object);
    nodes.set(node.id, { def: node, object, parentId });
    for (const child of node.children ?? []) visit(child, object, node.id);
  };
  visit(def.root, root, null);
  for (const joint of def.joints ?? []) attachJoint(def.id, joint, nodes);
  return { def, index, root, nodes, meshes, box: new THREE.Box3() };
}

function attachJoint(variantId, def, nodes) {
  const where = `variant ${variantId}, joint "${def.id}"`;
  const parent = nodes.get(def.parent);
  const child = nodes.get(def.child);
  if (!parent || !child) throw new SceneError(`${where}: unknown parent or child node`);
  if (child.parentId !== def.parent) throw new SceneError(`${where}: "${def.child}" is not a direct child of "${def.parent}"`);
  if (!(def.min < def.max) || def.nominal < def.min || def.nominal > def.max) {
    throw new SceneError(`${where}: needs min < max and nominal inside [min, max]`);
  }
  const axis = new THREE.Vector3(...def.axis);
  if (axis.lengthSq() < 1e-12) throw new SceneError(`${where}: axis is zero-length`);
  axis.normalize();
  const origin = new THREE.Vector3(...def.origin);
  const pivot = new THREE.Group();
  pivot.position.copy(origin);
  parent.object.add(pivot);
  child.object.position.sub(origin);
  pivot.add(child.object);
  if (def.type === "revolute") pivot.quaternion.setFromAxisAngle(axis, def.nominal * DEG);
  else pivot.position.addScaledVector(axis, def.nominal);
}

function validateScene(scene) {
  if (scene?.format !== "cad.concept-scene" || scene.version !== 1) {
    throw new SceneError('not a concept scene: expected "format": "cad.concept-scene", "version": 1');
  }
  if (!Array.isArray(scene.variants) || scene.variants.length < 1 || scene.variants.length > 4) {
    throw new SceneError("a scene renders 1 to 4 variants");
  }
}

function buildScene(scene) {
  validateScene(scene);
  const content = new THREE.Group();
  const variants = scene.variants.map((def, index) => buildVariant(def, index));
  // Lay out side by side along X at their authored nominal joint configurations.
  const sizes = variants.map((v) => new THREE.Box3().setFromObject(v.root));
  const widest = Math.max(...sizes.map((b) => b.max.x - b.min.x));
  const gap = Math.max(120, widest * 0.3);
  let cursor = 0;
  variants.forEach((variant, i) => {
    variant.root.position.x = cursor - sizes[i].min.x;
    cursor += sizes[i].max.x - sizes[i].min.x + gap;
    content.add(variant.root);
  });
  const total = new THREE.Box3().setFromObject(content);
  content.position.x = -(total.min.x + total.max.x) / 2;
  content.position.y = -(total.min.y + total.max.y) / 2;
  return { content, variants };
}

function makeGrid(content) {
  const box = new THREE.Box3().setFromObject(content);
  const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) * 1.3;
  const size = Math.ceil(span / 100) * 100;
  const grid = new THREE.GridHelper(size, size / 50, token("--color-grid-major"), token("--color-grid"));
  grid.rotation.x = Math.PI / 2;
  return grid;
}

// --- labels -----------------------------------------------------------------

const tmp = new THREE.Vector3();
const partBox = new THREE.Box3();

function makeLabels(variants) {
  ui.labels.replaceChildren();
  const labels = [];
  const add = (kind, text, variant, anchor) => {
    const el = document.createElement("span");
    el.className = "label";
    el.dataset.kind = kind;
    el.dataset.variant = variant.def.id;
    el.textContent = text;
    ui.labels.append(el);
    labels.push({ kind, el, variant, anchor, x: 0, y: 0, shown: false, w: 0, h: 0 });
  };
  for (const variant of variants) {
    add("variant", variant.def.label, variant, (out) => {
      variant.root.updateWorldMatrix(true, true);
      const box = variant.box.setFromObject(variant.root);
      return out.set((box.min.x + box.max.x) / 2, box.min.y, box.min.z);
    });
    for (const node of variant.nodes.values()) {
      if (node.parentId === null) continue; // the root group is the variant itself
      if (node.def.kind === "part") {
        // Front-face centre (the camera looks from -Y): wide parts such as a base plate
        // then label below their own group's pivot instead of on top of it.
        add("part", node.def.label, variant, (out) => {
          partBox.setFromObject(node.object);
          return out.set((partBox.min.x + partBox.max.x) / 2, partBox.min.y, (partBox.min.z + partBox.max.z) / 2);
        });
      } else {
        add("group", node.def.label, variant, (out) => node.object.getWorldPosition(out));
      }
    }
  }
  for (const label of labels) {
    label.w = label.el.offsetWidth;
    label.h = label.el.offsetHeight;
  }
  return labels;
}

function labelVisible(label) {
  if (label.kind === "variant") return true;
  // Dimmed variants keep their group labels; part labels belong to the selected variant.
  if (label.kind === "part") return ui.partLabels.checked && label.variant.def.id === state.selected;
  return ui.groupLabels.checked;
}

// Placement order: variant titles, then the selected variant, then the rest.
function labelRank(label) {
  if (label.kind === "variant") return 0;
  const selected = label.variant.def.id === state.selected;
  return (selected ? 1 : 3) + (label.kind === "part" ? 1 : 0);
}

function layoutLabels() {
  const width = ui.canvas.clientWidth;
  const height = ui.canvas.clientHeight;
  const placed = [];
  const overlaps = (x, y, w, h) =>
    placed.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
  const ordered = [...state.labels].sort((a, b) => labelRank(a) - labelRank(b));
  for (const label of ordered) {
    label.shown = false;
    if (labelVisible(label)) {
      label.anchor(tmp).project(camera);
      if (tmp.z < 1 && Math.abs(tmp.x) <= 1.05 && Math.abs(tmp.y) <= 1.05) {
        const cx = ((tmp.x + 1) / 2) * width;
        const cy = ((1 - tmp.y) / 2) * height + (label.kind === "variant" ? label.h : 0);
        const x = cx - label.w / 2;
        // Nudge one row down or up to clear earlier labels; a label that still collides
        // stays hidden until the user zooms in, so no label drifts away from its part.
        const dy = [0, 1, -1].map((k) => k * (label.h + 1)).find((d) => !overlaps(x, cy - label.h / 2 + d, label.w, label.h));
        if (dy !== undefined) {
          label.x = x;
          label.y = cy - label.h / 2 + dy;
          placed.push({ x: label.x, y: label.y, w: label.w, h: label.h });
          label.shown = true;
        }
      }
    }
    label.el.hidden = !label.shown;
    if (label.shown) label.el.style.transform = `translate(${Math.round(label.x)}px, ${Math.round(label.y)}px)`;
  }
}

// --- rendering --------------------------------------------------------------

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderNow();
  });
}

function renderNow() {
  renderer.render(world, camera);
  layoutLabels();
}

function resize() {
  const { clientWidth: w, clientHeight: h } = ui.stage;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderNow();
}
new ResizeObserver(resize).observe(ui.stage);

function fitView() {
  if (!state.content) return;
  const box = new THREE.Box3().setFromObject(state.content);
  const center = box.getCenter(new THREE.Vector3());
  // Camera basis for a front-right, slightly raised view; the variants run along X.
  const back = new THREE.Vector3(0.22, -1, 0.34).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, back).normalize();
  const up = new THREE.Vector3().crossVectors(back, right);
  const tanV = Math.tan((camera.fov * DEG) / 2);
  const tanH = tanV * camera.aspect;
  let distance = 0;
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const corner = new THREE.Vector3(x, y, z).sub(center);
        const need = Math.max(Math.abs(corner.dot(right)) / tanH, Math.abs(corner.dot(up)) / tanV);
        distance = Math.max(distance, need + corner.dot(back));
      }
  distance *= 1.08;
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(back, distance);
  camera.near = distance / 100;
  camera.far = distance * 20;
  camera.updateProjectionMatrix();
  controls.update();
  requestRender();
}

// --- selection --------------------------------------------------------------
function selectVariant(id) {
  const variant = state.variants.find((v) => v.def.id === id) ?? state.variants[0];
  if (!variant) return;
  state.selected = variant.def.id;
  for (const v of state.variants) {
    const on = v === variant;
    for (const mesh of v.meshes) {
      mesh.material.transparent = !on;
      mesh.material.opacity = on ? 1 : 0.5;
      mesh.material.depthWrite = on;
      mesh.userData.edges.material.color.copy(on ? accentColor : edgeColor);
      mesh.userData.edges.material.opacity = on ? 1 : 0.35;
    }
  }
  for (const label of state.labels) {
    const on = label.variant === variant;
    label.el.dataset.dim = String(!on);
    label.el.dataset.variantSelected = String(on);
  }
  for (const button of ui.variants.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.variant === variant.def.id));
  }
  requestRender();
}

function renderVariantList(scene) {
  ui.variants.replaceChildren();
  for (const def of scene.variants) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "variant";
    button.dataset.variant = def.id;
    button.setAttribute("aria-pressed", "false");
    const name = document.createElement("span");
    name.className = "variant-name";
    name.textContent = def.label;
    if (scene.chosen === def.id) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Chosen";
      name.append(badge);
    }
    button.append(name);
    if (def.summary) {
      const summary = document.createElement("span");
      summary.className = "variant-summary";
      summary.textContent = def.summary;
      button.append(summary);
    }
    button.addEventListener("click", () => selectVariant(def.id));
    item.append(button);
    ui.variants.append(item);
  }
}

// Click a part to highlight its variant independently of canvas orbit gestures.
const raycaster = new THREE.Raycaster();
let pressAt = null;
ui.canvas.addEventListener("pointerdown", (event) => {
  pressAt = { x: event.clientX, y: event.clientY };
});
ui.canvas.addEventListener("pointerup", (event) => {
  if (!pressAt || Math.hypot(event.clientX - pressAt.x, event.clientY - pressAt.y) > 4) return;
  const rect = ui.canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(state.variants.flatMap((variant) => variant.meshes), false)[0];
  if (hit) selectVariant(hit.object.userData.variantId);
});

// --- loading and live reload ------------------------------------------------
function setStatus(text, kind = "info") {
  ui.status.textContent = text;
  document.body.dataset.state = kind;
}

function setControlsEnabled(on) {
  ui.shot.disabled = !on;
  ui.fit.disabled = !on;
}

function showOverlay(kind, title, body) {
  ui.overlay.hidden = false;
  ui.overlay.dataset.kind = kind;
  ui.overlayTitle.textContent = title;
  ui.overlayBody.textContent = body;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new SceneError(`${url}: HTTP ${response.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SceneError(`${url} is not valid JSON: ${error.message}`);
  }
}

async function listScenes() {
  const { scenes } = await fetchJson("/api/scenes");
  ui.select.replaceChildren(
    ...scenes.map((name) => {
      const option = document.createElement("option");
      option.value = option.textContent = name;
      return option;
    }),
  );
  ui.picker.hidden = scenes.length < 2;
  return scenes;
}

function disposeContent() {
  if (!state.content) return;
  world.remove(state.content, state.grid);
  state.content.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
  state.grid?.geometry.dispose();
}

async function loadScene({ reason }) {
  const scene = await fetchJson(`/scenes/${encodeURIComponent(state.file)}`);
  const built = buildScene(scene);
  disposeContent();
  state.scene = scene;
  state.content = built.content;
  state.variants = built.variants;
  state.grid = makeGrid(built.content);
  world.add(state.content, state.grid);
  state.labels = makeLabels(state.variants);
  ui.title.textContent = scene.title;
  ui.file.textContent = state.file;
  ui.select.value = state.file;
  ui.overlay.hidden = true;
  ui.notice.hidden = true;
  renderVariantList(scene);
  const keep = state.variants.some((v) => v.def.id === state.selected);
  selectVariant(keep ? state.selected : scene.chosen ?? state.variants[0].def.id);
  if (!state.framed) {
    fitView();
    state.framed = true;
  }
  setControlsEnabled(true);
  const time = new Date().toLocaleTimeString();
  setStatus(`${reason} ${state.file} · ${state.variants.length} variants · ${time}`);
  window.dispatchEvent(new CustomEvent("cad-concept:loaded", { detail: { file: state.file, reason } }));
}

async function load(reason) {
  try {
    if (!state.file) {
      const scenes = await listScenes();
      const wanted = new URLSearchParams(location.search).get("scene");
      state.file = scenes.includes(wanted) ? wanted : scenes[0] ?? null;
      if (!state.file) {
        setControlsEnabled(false);
        showOverlay("empty", "No scene files yet", "Write a *.scene.json into the scene directory; the viewer loads it as soon as it appears.");
        setStatus("Waiting for a scene file");
        return;
      }
    }
    setStatus(`Loading ${state.file}…`, "loading");
    await loadScene({ reason });
  } catch (error) {
    const message = error instanceof SceneError ? error.message : String(error?.stack ?? error);
    if (state.content) {
      ui.notice.hidden = false;
      ui.notice.textContent = `Reload failed, showing the last good scene. ${message}`;
      setStatus(`Reload of ${state.file} failed`, "error");
    } else {
      setControlsEnabled(false);
      showOverlay("error", "The scene could not be shown", message);
      setStatus(`Could not load ${state.file ?? "the scene list"}`, "error");
    }
    window.dispatchEvent(new CustomEvent("cad-concept:error", { detail: { message } }));
  }
}

function connectLive() {
  const events = new EventSource("/events");
  events.addEventListener("hello", () => {
    ui.live.dataset.state = "live";
    ui.live.textContent = "Live";
  });
  events.addEventListener("error", () => {
    ui.live.dataset.state = "offline";
    ui.live.textContent = "Reconnecting";
  });
  events.addEventListener("change", (event) => {
    const { files } = JSON.parse(event.data);
    if (!state.file || files.includes(state.file)) {
      if (!state.file) listScenes().catch(() => {});
      load("Reloaded");
    } else {
      listScenes().catch(() => {});
    }
  });
}

// --- screenshot -------------------------------------------------------------

function compositeScreenshot() {
  renderNow();
  const dpr = ui.canvas.width / ui.canvas.clientWidth;
  const out = document.createElement("canvas");
  out.width = ui.canvas.width;
  out.height = ui.canvas.height;
  const ctx = out.getContext("2d");
  ctx.drawImage(ui.canvas, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.textBaseline = "middle";
  for (const label of state.labels) {
    if (!label.shown) continue;
    const style = getComputedStyle(label.el);
    ctx.globalAlpha = Number(style.opacity);
    ctx.fillStyle = style.backgroundColor;
    ctx.beginPath();
    ctx.roundRect(label.x, label.y, label.w, label.h, Number.parseFloat(style.borderTopLeftRadius));
    ctx.fill();
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.fillStyle = style.color;
    ctx.fillText(label.el.textContent, label.x + Number.parseFloat(style.paddingLeft), label.y + label.h / 2);
  }
  return out.toDataURL("image/png");
}

async function saveScreenshot() {
  ui.shot.setAttribute("aria-busy", "true");
  ui.shot.disabled = true;
  ui.shotResult.dataset.kind = "info";
  ui.shotResult.textContent = "Saving…";
  try {
    const capture = {
      scene: state.file,
      scene_sha256: await (await fetch(`/scenes/${encodeURIComponent(state.file)}`, { cache: "no-store" }))
        .then((response) => response.arrayBuffer())
        .then((bytes) => crypto.subtle.digest("SHA-256", bytes))
        .then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")),
      variant: state.selected,
      camera: { position: controls.object.position.toArray(), quaternion: controls.object.quaternion.toArray(), zoom: controls.object.zoom },
      viewport: { width: ui.canvas.width, height: ui.canvas.height, device_pixel_ratio: window.devicePixelRatio },
      labels: { parts: ui.partLabels.checked, groups: ui.groupLabels.checked },
    };
    const response = await fetch("/api/screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene: state.file, variant: state.selected, capture, png: compositeScreenshot() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    ui.shotResult.textContent = `Saved ${result.path}`;
    return result.path;
  } catch (error) {
    ui.shotResult.dataset.kind = "error";
    ui.shotResult.textContent = `Screenshot not saved: ${error.message}`;
    throw error;
  } finally {
    ui.shot.removeAttribute("aria-busy");
    ui.shot.disabled = false;
  }
}
ui.select.addEventListener("change", () => {
  state.file = ui.select.value;
  state.framed = false;
  const url = new URL(location.href);
  url.searchParams.set("scene", state.file);
  history.replaceState(null, "", url);
  load("Loaded");
});

// Automation surface for agents and tests driving the viewer through a browser.
window.cadConcept = {
  ready: null,
  get file() {
    return state.file;
  },
  get selected() {
    return state.selected;
  },
  select: selectVariant,
  screenshot: compositeScreenshot,
  save: saveScreenshot,
};

resize();
connectLive();
window.cadConcept.ready = load("Loaded");
