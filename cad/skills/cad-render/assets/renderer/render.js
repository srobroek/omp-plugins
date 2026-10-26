// Static product renderer for cad-render. render.py serves this page with /render/scene.json
// (parts, PBR materials, views, explode offsets) and /render/model.glb (the version GLB), then
// calls window.cadRender.capture(view) once per view. Each capture returns the beauty frame as a
// PNG data URL plus its raw RGBA pixels, and a subject mask, so render.py can grade the frame.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const css = getComputedStyle(document.documentElement);
const token = (name) => css.getPropertyValue(name).trim();
const statusEl = document.getElementById("status");
const canvas = document.getElementById("render");

// Studio set-up. Directions are in the GLB frame: metres, +Y up.
const STUDIO = {
  fovDeg: 28,
  margin: 0.08, // fraction of each half-frame left empty around the subject and its shadow
  exposure: 1.0,
  environmentIntensity: 0.85,
  // Product-photography key: high (about 63 deg elevation) and in front, so the shadow falls
  // beneath and just behind the product.
  keyFrom: [0.05, 1.0, 0.5],
  keyIntensity: 2.2,
  keyShadowRadius: 22, // VSM blur radius in shadow-map texels: the soft penumbra
  // Overhead contact light: a weak, very soft shadow straight down, cast only by geometry
  // within contactHeight (fraction of the scene's bounding radius) of the ground, so it darkens
  // the floor under the base without doubling the shadow of anything higher up.
  contactIntensity: 0.5,
  contactShadowRadius: 55,
  contactHeight: 0.14,
  fillFrom: [0.8, 0.5, -0.6],
  fillIntensity: 0.6,
  shadowMapSize: 1024,
  shadowBlurSamples: 24,
  aoRadius: 0.08, // GTAO radius and depth thickness, as a fraction of the subject's bounding radius
  msaaSamples: 4,
  maxPointsPerMesh: 6000,
};
// Mask classes, written as linear grey levels into an 8-bit render target.
const MASK_SUBJECT = new THREE.Color(1, 1, 1);
const MASK_OTHER = new THREE.Color(0.5, 0.5, 0.5);
const COLOR_KEYS = ["color", "sheenColor", "specularColor", "attenuationColor", "emissive"];

function setStatus(state, text) {
  document.body.dataset.state = state;
  statusEl.textContent = text;
}

function physicalMaterial(spec) {
  const params = {};
  for (const [key, value] of Object.entries(spec.pbr)) {
    params[key] = COLOR_KEYS.includes(key) ? new THREE.Color(value) : value;
  }
  const material = new THREE.MeshPhysicalMaterial(params);
  material.name = spec.id;
  return material;
}

function readBack(material) {
  const out = {};
  for (const key of ["metalness", "roughness", "clearcoat", "clearcoatRoughness", "sheen", "sheenRoughness", "transmission", "thickness", "ior"]) {
    out[key] = Number(material[key].toFixed(4));
  }
  out.color = `#${material.color.getHexString()}`;
  out.type = material.type;
  out.name = material.name;
  return out;
}

function vertexSample(meshes) {
  const points = [];
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const position = mesh.geometry.attributes.position;
    const step = Math.max(1, Math.floor(position.count / STUDIO.maxPointsPerMesh));
    for (let i = 0; i < position.count; i += step) {
      points.push(v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).clone());
    }
  }
  return points;
}

// Camera that fits every point inside the frame with STUDIO.margin, looking along -direction.
function fitCamera(camera, points, direction) {
  const back = new THREE.Vector3(...direction).normalize();
  const forward = back.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const tanV = Math.tan((camera.fov * Math.PI) / 360) * (1 - STUDIO.margin);
  const tanH = tanV * camera.aspect;
  const target = new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
  let distance = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    distance = 0;
    for (const p of points) {
      const d = p.clone().sub(target);
      const z = d.dot(forward);
      distance = Math.max(distance, Math.abs(d.dot(right)) / tanH - z, Math.abs(d.dot(up)) / tanV - z);
    }
    // Re-centre on the projected extents: perspective makes near points spread wider.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      const d = p.clone().sub(target);
      const depth = distance + d.dot(forward);
      const x = d.dot(right) / depth, y = d.dot(up) / depth;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    target.addScaledVector(right, ((minX + maxX) / 2) * distance).addScaledVector(up, ((minY + maxY) / 2) * distance);
  }
  let farthest = 0;
  for (const p of points) farthest = Math.max(farthest, p.distanceTo(target));
  camera.position.copy(target).addScaledVector(back, distance);
  camera.up.copy(up);
  camera.near = Math.max(1e-4, distance - farthest * 1.5);
  camera.far = distance + farthest * 4 + 10;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  return { target, distance };
}

function toBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function boot() {
  const scene = await (await fetch("/render/scene.json", { cache: "no-store" })).json();
  const { width, height } = scene.image;
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = STUDIO.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const world = new THREE.Scene();
  const backdrop = new THREE.Color(token("--color-backdrop"));
  world.background = backdrop;
  const pmrem = new THREE.PMREMGenerator(renderer);
  world.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  world.environmentIntensity = STUDIO.environmentIntensity;

  const gltf = await new GLTFLoader().loadAsync(scene.glb);
  const root = gltf.scene;
  world.add(root);
  root.updateMatrixWorld(true);

  const parts = new Map();
  const owned = new Set();
  for (const part of scene.parts) {
    const material = physicalMaterial(part.material);
    const nodes = await Promise.all(part.node_indices.map((i) => gltf.parser.getDependency("node", i)));
    const meshes = [];
    for (const node of nodes) node.traverse((o) => { if (o.isMesh) meshes.push(o); });
    if (!meshes.length) throw new Error(`${part.pn}: no mesh under GLB nodes ${part.node_indices.join(", ")}`);
    for (const mesh of meshes) {
      mesh.material = material;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      owned.add(mesh);
    }
    parts.set(part.pn, { nodes, meshes, material, rest: nodes.map((n) => n.position.clone()) });
  }
  const unmapped = [];
  root.traverse((o) => { if (o.isMesh && !owned.has(o)) unmapped.push(o.name); });

  const restBox = new THREE.Box3().setFromObject(root);
  const groundY = restBox.min.y;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({ color: new THREE.Color(token("--color-shadow")), opacity: Number(token("--shadow-opacity")) }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = groundY;
  ground.receiveShadow = true;
  world.add(ground);

  function shadowLight(from, intensity, radius) {
    const light = new THREE.DirectionalLight(0xffffff, intensity);
    light.castShadow = true;
    light.shadow.mapSize.set(STUDIO.shadowMapSize, STUDIO.shadowMapSize);
    light.shadow.radius = radius;
    light.shadow.blurSamples = STUDIO.shadowBlurSamples;
    world.add(light, light.target);
    return { light, from: new THREE.Vector3(...from).normalize() };
  }
  const key = shadowLight(STUDIO.keyFrom, STUDIO.keyIntensity, STUDIO.keyShadowRadius);
  const contact = shadowLight([0, 1, 0.02], STUDIO.contactIntensity, STUDIO.contactShadowRadius); // 0.02: off-vertical for lookAt
  const keyDir = key.from;
  const fill = new THREE.DirectionalLight(0xffffff, STUDIO.fillIntensity);
  world.add(fill, fill.target);

  const camera = new THREE.PerspectiveCamera(STUDIO.fovDeg, width / height, 0.01, 100);
  const composerTarget = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: STUDIO.msaaSamples });
  const composer = new EffectComposer(renderer, composerTarget);
  composer.setPixelRatio(1);
  composer.setSize(width, height);
  composer.addPass(new RenderPass(world, camera));
  const gtao = new GTAOPass(world, camera, width, height);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.blendIntensity = 1.0;
  composer.addPass(gtao);
  composer.addPass(new OutputPass());

  const maskTarget = new THREE.WebGLRenderTarget(width, height);
  const maskSubject = new THREE.MeshBasicMaterial({ color: MASK_SUBJECT });
  const maskOther = new THREE.MeshBasicMaterial({ color: MASK_OTHER });
  const copy = document.createElement("canvas");
  copy.width = width;
  copy.height = height;
  const copyCtx = copy.getContext("2d", { willReadFrequently: true });

  function applyExplode(on) {
    for (const part of parts.values()) {
      part.nodes.forEach((node, i) => node.position.copy(part.rest[i]));
    }
    root.updateMatrixWorld(true);
    if (!on) return;
    for (const [pn, part] of parts) {
      const offset = scene.explode[pn];
      if (!offset) continue;
      part.nodes.forEach((node) => {
        const moved = node.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(...offset));
        node.position.copy(node.parent.worldToLocal(moved));
        node.updateMatrixWorld(true);
      });
    }
    root.updateMatrixWorld(true);
  }

  // Points of the subject and of their shadow footprint on the ground, so the frame holds both.
  function framingPoints(meshes) {
    const points = vertexSample(meshes);
    const shadows = [];
    for (const p of points) {
      const t = (p.y - groundY) / keyDir.y;
      shadows.push(new THREE.Vector3(p.x - keyDir.x * t, groundY, p.z - keyDir.z * t));
    }
    return points.concat(shadows);
  }

  function placeLights(box) {
    const centre = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const height = radius * 4;
    key.light.position.copy(centre).addScaledVector(key.from, height);
    key.light.target.position.copy(centre);
    const above = new THREE.Vector3(centre.x, groundY, centre.z);
    contact.light.position.copy(above).addScaledVector(contact.from, height);
    contact.light.target.position.copy(above);
    for (const { light } of [key, contact]) {
      const cam = light.shadow.camera;
      cam.left = -radius * 1.3; cam.right = radius * 1.3; cam.top = radius * 1.3; cam.bottom = -radius * 1.3;
      cam.near = radius * 0.5; cam.far = radius * 8;
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = radius * 0.004;
      light.shadow.needsUpdate = true;
    }
    // The contact map only sees the slab of geometry just above the ground.
    contact.light.shadow.camera.near = height - radius * STUDIO.contactHeight;
    contact.light.shadow.camera.far = height + radius * 0.05;
    for (const { light } of [key, contact]) light.shadow.camera.updateProjectionMatrix();
    fill.position.copy(centre).addScaledVector(new THREE.Vector3(...STUDIO.fillFrom).normalize(), radius * 4);
    fill.target.position.copy(centre);
    ground.scale.set(radius * 40, radius * 40, 1);
    ground.position.x = centre.x;
    ground.position.z = centre.z;
    return radius;
  }

  function renderMask(subject) {
    const saved = new Map();
    for (const [pn, part] of parts) {
      for (const mesh of part.meshes) {
        saved.set(mesh, mesh.material);
        mesh.material = subject.has(pn) ? maskSubject : maskOther;
      }
    }
    world.background = null;
    ground.visible = false;
    const toneMapping = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(maskTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(world, camera);
    const rgba = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(maskTarget, 0, 0, width, height, rgba);
    renderer.setRenderTarget(null);
    renderer.toneMapping = toneMapping;
    ground.visible = true;
    world.background = backdrop;
    for (const [mesh, material] of saved) mesh.material = material;
    // Flip to top-down rows and reduce to one class byte: 0 empty, 1 other part, 2 subject.
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const src = (height - 1 - y) * width * 4, dst = y * width;
      for (let x = 0; x < width; x += 1) {
        const r = rgba[src + x * 4];
        mask[dst + x] = r > 200 ? 2 : r > 60 ? 1 : 0;
      }
    }
    return mask;
  }

  async function capture(name) {
    const view = scene.views.find((v) => v.name === name);
    if (!view) throw new Error(`unknown view ${name}`);
    const started = performance.now();
    applyExplode(view.explode);
    const subject = new Set(view.subject ?? [...parts.keys()]);
    const subjectMeshes = [...subject].flatMap((pn) => {
      if (!parts.has(pn)) throw new Error(`view ${name}: unknown part ${pn}`);
      return parts.get(pn).meshes;
    });
    const sceneBox = new THREE.Box3().setFromObject(root);
    const radius = placeLights(sceneBox);
    const fit = fitCamera(camera, framingPoints(subjectMeshes), view.direction);
    const subjectRadius = new THREE.Box3().setFromPoints(vertexSample(subjectMeshes)).getSize(new THREE.Vector3()).length() / 2;
    const aoRadius = subjectRadius * STUDIO.aoRadius;
    gtao.updateGtaoMaterial({ radius: aoRadius, thickness: aoRadius, distanceExponent: 1, distanceFallOff: 1, scale: 1 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    composer.render();
    copyCtx.drawImage(renderer.domElement, 0, 0);
    const pixels = copyCtx.getImageData(0, 0, width, height).data;
    const png = copy.toDataURL("image/png");
    const mask = renderMask(subject);
    const applied = {};
    for (const [pn, part] of parts) applied[pn] = readBack(part.material);
    return {
      view: name,
      width,
      height,
      png,
      rgba: toBase64(new Uint8Array(pixels.buffer)),
      mask: toBase64(mask),
      camera: {
        frame: "glb",
        position: camera.position.toArray(),
        target: fit.target.toArray(),
        up: camera.up.toArray(),
        fov_deg: camera.fov,
        aspect: camera.aspect,
        near: camera.near,
        far: camera.far,
      },
      subject: [...subject],
      explode: Boolean(view.explode),
      materials: applied,
      scene_radius_m: radius,
      render_ms: Math.round(performance.now() - started),
    };
  }

  setStatus("ready", "Ready");
  return {
    capture,
    info: {
      three: THREE.REVISION,
      parts: [...parts.keys()],
      unmapped_meshes: unmapped,
      ground_y_m: groundY,
      studio: {
        ...STUDIO,
        toneMapping: "ACESFilmic",
        outputColorSpace: renderer.outputColorSpace,
        environment: "RoomEnvironment",
        ambientOcclusion: "GTAOPass",
        shadowMap: "VSMShadowMap",
        backdrop: `#${backdrop.getHexString()}`,
      },
    },
  };
}

const ready = boot().catch((error) => {
  setStatus("error", `Render failed: ${error.message}`);
  throw error;
});
window.cadRender = {
  ready: ready.then((api) => api.info),
  capture: async (name) => (await ready).capture(name),
};
