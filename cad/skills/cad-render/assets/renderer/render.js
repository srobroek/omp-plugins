// Static product renderer for cad-render. render.py serves this page with /render/scene.json
// (parts, PBR materials, views, explode offsets) and /render/model.glb (the version GLB), then
// calls window.cadRender.capture(view) once per view. Each capture returns the beauty frame as a
// PNG data URL plus its raw RGBA pixels, and a subject mask, so render.py can grade the frame.
// measureVisibility(check) counts mask pixels for one requirement visibility check, which
// render.py grades.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

const css = getComputedStyle(document.documentElement);
const token = (name) => css.getPropertyValue(name).trim();
const statusEl = document.getElementById("status");
const canvas = document.getElementById("render");

// Studio set-up. Directions are in the GLB frame: metres, +Y up.
function seedRandom(seed) {
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function viewSeed(name, attempt) {
  let hash = 2166136261;
  for (const char of `${name}:${attempt}`) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
const STUDIO = {
  fovDeg: 28,
  margin: 0.08, // fraction of each half-frame left empty around the subject and its shadow
  exposure: 1.0,
  environmentIntensity: 0.85,
  // Product-photography key: high (about 63 deg elevation) and in front. It lights the product
  // and shades the parts onto each other; the floor takes only the baked studio shadow below.
  keyFrom: [0.05, 1.0, 0.5],
  keyIntensity: 2.2,
  keyShadowRadius: 22, // VSM blur radius in shadow-map texels: the soft penumbra on the parts
  fillFrom: [0.8, 0.5, -0.6],
  fillIntensity: 0.6,
  shadowMapSize: 1024,
  shadowBlurSamples: 24,
  // Floor shadow, two baked terms, both once per pose.
  // Softbox: the occlusion of a large overhead softbox, accumulating groundSamples shadow maps
  // from directions spread cosine-weighted over a cone of groundConeDeg about vertical. A part
  // high above hides a small solid angle over a wide area: a faint, wide, soft shadow whose
  // penumbra grows and darkness falls with height. Its opacity is --shadow-opacity.
  groundSamples: 128,
  groundConeDeg: 75,
  groundExtent: 2.5, // half-side of the baked floor square, x the scene's bounding radius
  groundMapSize: 1024, // baked floor texels per side
  groundShadowMapSize: 512,
  groundShadowRadius: 3,
  // Contact: the studio's ambient occlusion at the foot of a part, ContactShadows-style. The
  // footprint of part surface within contactHeight of the floor, weighted 1 at the floor down to 0
  // at contactHeight, blurred by a Gaussian of contactBlur (both x the scene radius), at
  // contactOpacity. Nothing above contactHeight adds to it.
  contactHeight: 0.1,
  contactBlur: 0.13,
  contactOpacity: 0.7,
  contactMapSize: 256,
  // Grader zones, as fractions of the scene's bounding radius: part surface within contactBand
  // of the floor is a grounded rim; floor under a part at least overhangHeight up is overhung.
  contactBand: 0.02,
  overhangHeight: 0.25,
  aoRadius: 0.08, // GTAO radius and depth thickness, as a fraction of the subject's bounding radius
  msaaSamples: 4,
  maxPointsPerMesh: 6000,
};
// Mask pass output, into an 8-bit render target: r = part class level (subject 1, other 0.5,
// floor and empty 0), g = 1 on a grounded rim, b = 1 on overhung floor.
const MASK_SUBJECT = 1.0;
const MASK_OTHER = 0.5;
const COLOR_KEYS = ["color", "sheenColor", "specularColor", "attenuationColor", "emissive"];
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

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
function cameraBasis(direction, upReference) {
  const back = new THREE.Vector3(...direction).normalize();
  const forward = back.clone().negate();
  const upHint = new THREE.Vector3(...(upReference ?? (Math.abs(forward.y) > 0.98 ? [0, 0, 1] : [0, 1, 0])));
  const right = new THREE.Vector3().crossVectors(forward, upHint).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  return { back, forward, right, up };
}

function fitCamera(camera, points, direction, frameScale = 1, upReference) {
  const { back, forward, right, up } = cameraBasis(direction, upReference);
  const tanV = Math.tan((camera.fov * Math.PI) / 360) * (1 - STUDIO.margin) * frameScale;
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

// The camera as render.py records it (camera_record), in the GLB frame.
function cameraRecord(camera, target) {
  return {
    frame: "glb", position: camera.position.toArray(), target: target.toArray(), up: camera.up.toArray(),
    fov_deg: camera.fov, aspect: camera.aspect, near: camera.near, far: camera.far,
  };
}

function toBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

// Direction i of n towards the softbox: cosine-weighted over a cone about +Y, stratified in
// sin^2 of the polar angle with a golden-angle azimuth, so every bake is deterministic.
function coneDirection(i, n, coneRad) {
  const s = Math.sin(coneRad) * Math.sqrt((i + 0.5) / n);
  const phi = i * GOLDEN_ANGLE;
  return new THREE.Vector3(s * Math.cos(phi), Math.sqrt(1 - s * s), s * Math.sin(phi));
}

// Shaders. HEIGHT_VERTEX passes the world height above the floor; UV_VERTEX the floor-square uv.
const HEIGHT_VERTEX = `
uniform float groundY;
varying float vHeight;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vHeight = world.y - groundY;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;
const UV_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
// Beauty floor: the two baked terms as shadow opacity, composited. A wall standing on the floor
// hides half the softbox cone from the floor at its foot, and the blurred footprint is 0.5 on its
// edge, so 0.5 is full darkness for both. The contact map is drawn from below: mirrored in x.
const FLOOR_SHADOW_FRAGMENT = `
uniform sampler2D occlusion;
uniform sampler2D contact;
uniform vec3 color;
uniform float opacity;
uniform float contactOpacity;
varying vec2 vUv;
void main() {
  float softbox = opacity * clamp(2.0 * texture2D(occlusion, vUv).g, 0.0, 1.0);
  float foot = contactOpacity * clamp(2.0 * texture2D(contact, vec2(1.0 - vUv.x, vUv.y)).r, 0.0, 1.0);
  gl_FragColor = vec4(color, 1.0 - (1.0 - softbox) * (1.0 - foot));
}`;
// One separable Gaussian pass over the contact footprint. With `weigh`, the source is the height
// map, turned into the footprint weight 1 - height / contactHeight; otherwise it is the first pass.
const CONTACT_BLUR_FRAGMENT = `
uniform sampler2D source;
uniform bool weigh;
uniform float contactHeight;
uniform vec2 texel;
uniform float sigma;
varying vec2 vUv;
float footprint(vec2 uv) {
  vec4 t = texture2D(source, uv);
  if (!weigh) return t.r;
  return t.a > 0.5 ? clamp(1.0 - t.r / contactHeight, 0.0, 1.0) : 0.0;
}
void main() {
  float sum = 0.0;
  float total = 0.0;
  for (int i = -24; i <= 24; i++) {
    float w = exp(-0.5 * float(i * i) / (sigma * sigma));
    sum += w * footprint(vUv + float(i) * texel);
    total += w;
  }
  gl_FragColor = vec4(sum / total, 0.0, 0.0, 1.0);
}`;
const HEIGHT_FRAGMENT = `
varying float vHeight;
void main() {
  gl_FragColor = vec4(vHeight, 0.0, 0.0, 1.0);
}`;
const MASK_PART_FRAGMENT = `
uniform float level;
uniform float band;
varying float vHeight;
void main() {
  gl_FragColor = vec4(level, vHeight < band ? 1.0 : 0.0, 0.0, 1.0);
}`;
// The height map is drawn from below the floor, so it is mirrored in x against the floor uv.
const MASK_FLOOR_FRAGMENT = `
uniform sampler2D heights;
uniform float overhang;
varying vec2 vUv;
void main() {
  vec4 lowest = texture2D(heights, vec2(1.0 - vUv.x, vUv.y));
  gl_FragColor = vec4(0.0, 0.0, lowest.a > 0.5 && lowest.r >= overhang ? 1.0 : 0.0, 1.0);
}`;

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

  // One entry per occurrence (scene.parts[].id; a legacy part's id is its PN). Materials stay per
  // part definition: every occurrence of a PN carries its PN's material spec.
  const parts = new Map();
  const owned = new Set();
  for (const part of scene.parts) {
    const material = physicalMaterial(part.material);
    const nodes = await Promise.all(part.node_indices.map((i) => gltf.parser.getDependency("node", i)));
    const meshes = [];
    for (const node of nodes) node.traverse((o) => { if (o.isMesh) meshes.push(o); });
    if (!meshes.length) throw new Error(`${part.ref}: no mesh under GLB nodes ${part.node_indices.join(", ")}`);
    for (const mesh of meshes) {
      mesh.material = material;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      owned.add(mesh);
    }
    parts.set(part.id, { pn: part.pn, nodes, meshes, material, rest: nodes.map((n) => ({
      parent: n.parent, position: n.position.clone(), quaternion: n.quaternion.clone(), scale: n.scale.clone(),
      visible: n.visible,
    })) });
  }
  const unmapped = [];
  root.traverse((o) => { if (o.isMesh && !owned.has(o)) unmapped.push(o.name); });

  const restBox = new THREE.Box3().setFromObject(root);
  const groundY = restBox.min.y;
  // The floor: a square under the scene (placed per pose by stage) that shows only the baked
  // shadow: the softbox term in `occlusion`, the contact term in `contact` (blurred through
  // `contactPass`). `heights` holds the lowest part surface above each floor texel.
  const occlusion = new THREE.WebGLRenderTarget(STUDIO.groundMapSize, STUDIO.groundMapSize, { type: THREE.HalfFloatType });
  const heights = new THREE.WebGLRenderTarget(STUDIO.groundMapSize / 2, STUDIO.groundMapSize / 2, {
    type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const contactPass = new THREE.WebGLRenderTarget(STUDIO.contactMapSize, STUDIO.contactMapSize, { type: THREE.HalfFloatType });
  const contact = new THREE.WebGLRenderTarget(STUDIO.contactMapSize, STUDIO.contactMapSize, { type: THREE.HalfFloatType });
  const contactBlur = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: {
      source: { value: null },
      weigh: { value: true },
      contactHeight: { value: 0 },
      texel: { value: new THREE.Vector2() },
      // Gaussian sigma in contact texels; independent of the scene size, as both scale with it.
      sigma: { value: (STUDIO.contactBlur * STUDIO.contactMapSize) / (2 * STUDIO.groundExtent) },
    },
    vertexShader: UV_VERTEX,
    fragmentShader: CONTACT_BLUR_FRAGMENT,
  }));
  const floorShadow = new THREE.ShaderMaterial({
    uniforms: {
      occlusion: { value: occlusion.texture },
      contact: { value: contact.texture },
      color: { value: new THREE.Color(token("--color-shadow")) },
      opacity: { value: Number(token("--shadow-opacity")) },
      contactOpacity: { value: STUDIO.contactOpacity },
    },
    vertexShader: UV_VERTEX,
    fragmentShader: FLOOR_SHADOW_FRAGMENT,
    transparent: true,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorShadow);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = groundY;
  world.add(ground);

  function shadowLight(intensity, mapSize, radius, blurSamples) {
    const light = new THREE.DirectionalLight(0xffffff, intensity);
    light.castShadow = true;
    light.shadow.mapSize.set(mapSize, mapSize);
    light.shadow.radius = radius;
    light.shadow.blurSamples = blurSamples;
    return light;
  }
  // Points `light` along `from` at the sphere (centre, radius), its shadow camera enclosing it.
  function aimShadowLight(light, centre, from, radius) {
    light.position.copy(centre).addScaledVector(from, radius * 4);
    light.target.position.copy(centre);
    const cam = light.shadow.camera;
    cam.left = -radius * 1.3; cam.right = radius * 1.3; cam.top = radius * 1.3; cam.bottom = -radius * 1.3;
    cam.near = radius * 0.5; cam.far = radius * 8;
    cam.updateProjectionMatrix();
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = radius * 0.004;
  }
  const key = shadowLight(STUDIO.keyIntensity, STUDIO.shadowMapSize, STUDIO.keyShadowRadius, STUDIO.shadowBlurSamples);
  const keyDir = new THREE.Vector3(...STUDIO.keyFrom).normalize();
  const fill = new THREE.DirectionalLight(0xffffff, STUDIO.fillIntensity);
  world.add(key, key.target, fill, fill.target);

  // Floor bake (STUDIO.groundSamples). The parts and the floor move into their own scene, so the
  // studio key casts nothing on the floor; there the parts only cast, drawn with no output.
  const bakeScene = new THREE.Scene();
  const bakeLight = shadowLight(1, STUDIO.groundShadowMapSize, STUDIO.groundShadowRadius, 8);
  bakeScene.add(bakeLight, bakeLight.target);
  const bakeCamera = new THREE.OrthographicCamera();
  const bakeShadow = new THREE.ShadowMaterial({
    color: 0xffffff, opacity: 1 / STUDIO.groundSamples, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
  });
  const castOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthTest: false, depthWrite: false });
  const heightMaterial = new THREE.ShaderMaterial({
    uniforms: { groundY: { value: groundY } }, vertexShader: HEIGHT_VERTEX, fragmentShader: HEIGHT_FRAGMENT, side: THREE.DoubleSide,
  });
  let bakedPose = null;

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
  const zones = { groundY: { value: groundY }, band: { value: 0 }, overhang: { value: 0 } };
  const maskPart = (level) => new THREE.ShaderMaterial({
    uniforms: { groundY: zones.groundY, band: zones.band, level: { value: level } },
    vertexShader: HEIGHT_VERTEX,
    fragmentShader: MASK_PART_FRAGMENT,
  });
  const maskSubject = maskPart(MASK_SUBJECT);
  const maskOther = maskPart(MASK_OTHER);
  const maskGhost = new THREE.ShaderMaterial({
    uniforms: { groundY: zones.groundY, band: zones.band, level: { value: 0.8 } },
    vertexShader: HEIGHT_VERTEX,
    fragmentShader: MASK_PART_FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
  const maskFloor = new THREE.ShaderMaterial({
    uniforms: { heights: { value: heights.texture }, overhang: zones.overhang },
    vertexShader: UV_VERTEX,
    fragmentShader: MASK_FLOOR_FRAGMENT,
  });
  const copy = document.createElement("canvas");
  copy.width = width;
  copy.height = height;
  const copyCtx = copy.getContext("2d", { willReadFrequently: true });

  function applyExplode(on) {
    for (const part of parts.values()) {
      part.nodes.forEach((node, i) => {
        if (node.parent !== part.rest[i].parent) part.rest[i].parent.attach(node);
        node.position.copy(part.rest[i].position);
        node.quaternion.copy(part.rest[i].quaternion);
        node.scale.copy(part.rest[i].scale);
        node.visible = part.rest[i].visible;
      });
    }
    root.updateMatrixWorld(true);
    if (!on) return;
    for (const [id, part] of parts) {
      const offset = scene.explode[id];
      if (!offset) continue;
      part.nodes.forEach((node) => {
        const moved = node.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(...offset));
        node.position.copy(node.parent.worldToLocal(moved));
        node.updateMatrixWorld(true);
      });
    }
    root.updateMatrixWorld(true);
  }

  function restOnFloor(id) {
    const part = parts.get(id);
    const box = new THREE.Box3().makeEmpty();
    part.meshes.forEach((mesh) => box.expandByObject(mesh));
    const size = box.getSize(new THREE.Vector3());
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    axes.sort((a, b) => {
      const extent = (d) => Math.abs(d.x) * size.x + Math.abs(d.y) * size.y + Math.abs(d.z) * size.z;
      return extent(a) - extent(b);
    });
    // Align the narrowest principal bounding-box axis to vertical for a broad, stable resting face.
    const rotation = new THREE.Quaternion().setFromUnitVectors(axes[0], new THREE.Vector3(0, 1, 0));
    const centre = box.getCenter(new THREE.Vector3());
    const pivot = new THREE.Object3D();
    root.add(pivot);
    pivot.position.copy(centre);
    pivot.quaternion.copy(rotation);
    root.updateMatrixWorld(true);
    for (const node of part.nodes) {
      const position = node.getWorldPosition(new THREE.Vector3());
      const orientation = node.getWorldQuaternion(new THREE.Quaternion());
      pivot.add(node);
      node.position.copy(position.sub(centre));
      node.quaternion.copy(orientation);
    }
    root.updateMatrixWorld(true);
    const resting = new THREE.Box3().makeEmpty();
    part.meshes.forEach((mesh) => resting.expandByObject(mesh));
    pivot.position.y += groundY - resting.min.y;
    root.updateMatrixWorld(true);
  }

  function isolatedFramingPoints(meshes) {
    const box = new THREE.Box3().makeEmpty();
    meshes.forEach((mesh) => box.expandByObject(mesh));
    const source = vertexSample(meshes);
    const points = [...source];
    for (const p of source) {
      const t = (p.y - box.min.y) / keyDir.y;
      points.push(new THREE.Vector3(p.x - keyDir.x * t, box.min.y, p.z - keyDir.z * t));
    }
    return points;
  }

  // Points of the subject and of their key-light projection on the floor, so the frame holds the
  // subject and the floor its shadow falls on.
  function framingPoints(meshes) {
    const points = vertexSample(meshes);
    const shadows = [];
    for (const p of points) {
      const t = (p.y - groundY) / keyDir.y;
      shadows.push(new THREE.Vector3(p.x - keyDir.x * t, groundY, p.z - keyDir.z * t));
    }
    return points.concat(shadows);
  }

  // Runs `body` with each part drawn by partMaterial(pn) and the floor by floorMaterial (hidden
  // when null), then restores the beauty materials.
  function withMaterials(partMaterial, floorMaterial, body) {
    const saved = new Map();
    for (const [id, part] of parts) {
      for (const mesh of part.meshes) {
        saved.set(mesh, mesh.material);
        mesh.material = partMaterial(id);
      }
    }
    ground.material = floorMaterial ?? floorShadow;
    ground.visible = floorMaterial !== null;
    try {
      return body();
    } finally {
      for (const [mesh, material] of saved) mesh.material = material;
      ground.material = floorShadow;
      ground.visible = true;
    }
  }

  // Orthographic camera square over the floor, from above (uv-aligned) or from below (mirrored in x).
  function aimFloorCamera(floor, half, fromBelow) {
    bakeCamera.left = -half; bakeCamera.right = half; bakeCamera.top = half; bakeCamera.bottom = -half;
    bakeCamera.near = half * 0.5; bakeCamera.far = half * 4;
    bakeCamera.position.copy(floor);
    bakeCamera.position.y += fromBelow ? -half : half;
    bakeCamera.up.set(0, 0, -1);
    bakeCamera.lookAt(floor);
    bakeCamera.updateProjectionMatrix();
  }

  // Bakes, for the current pose, the lowest part surface above each floor texel, the contact term
  // from it, and the softbox occlusion (the mean shadow of the bake light over the cone). The
  // softbox samples PCF shadows: VSM's variance bound lightens the floor right at a contact.
  function bakeFloor(centre, radius) {
    const half = radius * STUDIO.groundExtent;
    const floor = new THREE.Vector3(centre.x, groundY, centre.z);
    const cone = THREE.MathUtils.degToRad(STUDIO.groundConeDeg);
    const beautyShadowType = renderer.shadowMap.type;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    bakeScene.add(root, ground);
    renderer.setClearColor(0x000000, 0);
    try {
      aimFloorCamera(floor, half, true);
      renderer.setRenderTarget(heights);
      withMaterials(() => heightMaterial, null, () => renderer.render(bakeScene, bakeCamera));
      const blur = contactBlur.material.uniforms;
      blur.contactHeight.value = radius * STUDIO.contactHeight;
      for (const [source, weigh, dx, dy, target] of [[heights, true, 1, 0, contactPass], [contactPass, false, 0, 1, contact]]) {
        blur.source.value = source.texture;
        blur.weigh.value = weigh;
        blur.texel.value.set(dx / STUDIO.contactMapSize, dy / STUDIO.contactMapSize);
        renderer.setRenderTarget(target);
        contactBlur.render(renderer);
      }
      aimFloorCamera(floor, half, false);
      renderer.setRenderTarget(occlusion);
      renderer.clear();
      renderer.autoClear = false;
      ground.receiveShadow = true;
      withMaterials(() => castOnly, bakeShadow, () => {
        for (let i = 0; i < STUDIO.groundSamples; i += 1) {
          aimShadowLight(bakeLight, centre, coneDirection(i, STUDIO.groundSamples, cone), radius);
          renderer.render(bakeScene, bakeCamera);
        }
      });
    } finally {
      ground.receiveShadow = false;
      renderer.autoClear = true;
      renderer.setRenderTarget(null);
      renderer.shadowMap.type = beautyShadowType;
      world.add(root, ground);
    }
  }

  // Points the key and the fill at the sphere (centre, radius).
  function aimLights(centre, radius) {
    aimShadowLight(key, centre, keyDir, radius);
    fill.position.copy(centre).addScaledVector(new THREE.Vector3(...STUDIO.fillFrom).normalize(), radius * 4);
    fill.target.position.copy(centre);
  }

  // Places the key, the fill, the floor square, and the grader zones around the scene's bounding
  // sphere, and rebakes the floor when the pose changed. Returns the radius.
  function stage(box, pose) {
    const centre = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    aimLights(centre, radius);
    const side = 2 * radius * STUDIO.groundExtent;
    ground.scale.set(side, side, 1);
    ground.position.x = centre.x;
    ground.position.z = centre.z;
    ground.updateMatrixWorld();
    zones.band.value = radius * STUDIO.contactBand;
    zones.overhang.value = radius * STUDIO.overhangHeight;
    const visibleGeometry = [...parts.values()]
      .filter((part) => part.nodes.some((node) => node.visible))
      .flatMap((part) => part.nodes.map((node) => {
        node.updateWorldMatrix(true, true);
        return `${node.uuid}:${node.matrixWorld.elements.join(",")}:${node.visible}`;
      }))
      .sort().join("|");
    const bakeKey = `${pose}:${visibleGeometry}:${centre.toArray().join(",")}:${radius}:${STUDIO.groundSamples}:${STUDIO.groundMapSize}:${STUDIO.groundShadowMapSize}:${STUDIO.groundConeDeg}:${STUDIO.groundExtent}`;
    if (bakedPose !== bakeKey) {
      bakeFloor(centre, radius);
      bakedPose = bakeKey;
    }
    return radius;
  }

  // One mask pass into maskTarget: each part drawn by partMaterial(id), the floor by floorMaterial
  // (left out when null). Returns the RGBA bytes in bottom-up rows; maskClass reads a pixel's class.
  function readMask(partMaterial, floorMaterial) {
    const rgba = new Uint8Array(width * height * 4);
    world.background = null;
    const toneMapping = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    withMaterials(partMaterial, floorMaterial, () => {
      renderer.setRenderTarget(maskTarget);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(world, camera);
      renderer.readRenderTargetPixels(maskTarget, 0, 0, width, height, rgba);
    });
    renderer.setRenderTarget(null);
    renderer.toneMapping = toneMapping;
    world.background = backdrop;
    return rgba;
  }
  const maskClass = (r) => (r > 200 ? 2 : r > 60 ? 1 : 0);

  // Class mask (0 empty, 1 other part, 2 subject) and floor zones (1 grounded rim on a part,
  // 2 overhung floor, else 0), both one byte per pixel in top-down rows.
  function renderMask(subject, ghostOccluders = false) {
    const rgba = readMask((id) => {
      if (subject.has(id)) return maskSubject;
      return ghostOccluders ? maskGhost : maskOther;
    }, maskFloor);
    const mask = new Uint8Array(width * height);
    const floor = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const src = (height - 1 - y) * width * 4, dst = y * width;
      for (let x = 0; x < width; x += 1) {
        const [r, g, b] = rgba.subarray(src + x * 4, src + x * 4 + 3);
        const cls = maskClass(r);
        mask[dst + x] = cls;
        floor[dst + x] = cls ? (g > 127 ? 1 : 0) : b > 127 ? 2 : 0;
      }
    }
    return { mask, floor };
  }
  function withGhostContext(subject, body) {
    const saved = new Map();
    for (const [id, part] of parts) {
      if (subject.has(id)) continue;
      for (const mesh of part.meshes) {
        saved.set(mesh, mesh.material);
        const ghost = mesh.material.clone();
        ghost.transparent = true;
        ghost.opacity = 0.22;
        ghost.depthWrite = false;
        mesh.material = ghost;
      }
    }
    try { return body(); }
    finally {
      for (const [mesh, material] of saved) {
        mesh.material.dispose();
        mesh.material = material;
      }
    }
  }

  function withIsolatedSubject(subject, body) {
    const hidden = [];
    for (const [id, part] of parts) {
      if (subject.has(id)) continue;
      // A GLB node holding one primitive is itself the mesh: list it once, so it is restored visible.
      for (const object of new Set([...part.nodes, ...part.meshes])) {
        hidden.push([object, object.visible]);
        object.visible = false;
      }
    }
    try { root.updateMatrixWorld(true); return body(); }
    finally {
      for (const [object, visible] of hidden) object.visible = visible;
      root.updateMatrixWorld(true);
    }
  }

  // A requirement visibility check at the built (nominal) pose. The camera looks along the check's
  // direction, framed on its window and target parts; every other part is hidden and the floor left
  // out. Per target: its silhouette drawn alone, and the pixels where it stays the nearest surface
  // with the occluders drawn too, which are the other window and target parts except see-through ones.
  function measureVisibility(check) {
    applyExplode(false);
    for (const part of parts.values()) part.nodes.forEach((node, i) => { node.visible = part.rest[i].visible; });
    const drawn = [...new Set([...check.window, ...check.targets])];
    const unknown = drawn.filter((id) => !parts.has(id));
    if (unknown.length) throw new Error(`visibility check names unknown occurrences ${unknown.join(", ")}`);
    const seeThrough = new Set(check.see_through);
    const fit = fitCamera(camera, vertexSample(drawn.flatMap((id) => parts.get(id).meshes)), check.direction, 1, check.up);
    const nearestPixels = (target, shown) => withIsolatedSubject(shown, () => {
      const rgba = readMask((id) => (id === target ? maskSubject : maskOther), null);
      let count = 0;
      for (let i = 0; i < rgba.length; i += 4) if (maskClass(rgba[i]) === 2) count += 1;
      return count;
    });
    const targets = check.targets.map((id) => ({
      occurrence: id,
      silhouette_px: nearestPixels(id, new Set([id])),
      visible_px: nearestPixels(id, new Set([id, ...drawn.filter((other) => other !== id && !seeThrough.has(other))])),
    }));
    return { targets, camera: cameraRecord(camera, fit.target) };
  }
  // Clip the renderer's square floor against the camera frustum, rather than testing its bounding
  // sphere (which can overlap the view when the floor itself is entirely out of frame).
  function floorIntersectsFrustum() {
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    ground.updateMatrixWorld(true);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    let polygon = [
      new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0),
      new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0),
    ].map((corner) => corner.applyMatrix4(ground.matrixWorld));
    for (const plane of frustum.planes) {
      if (!polygon.length) return false;
      const clipped = [];
      for (let index = 0; index < polygon.length; index += 1) {
        const start = polygon[index];
        const end = polygon[(index + 1) % polygon.length];
        const startDistance = plane.distanceToPoint(start);
        const endDistance = plane.distanceToPoint(end);
        if (startDistance >= 0) clipped.push(start);
        if ((startDistance < 0 && endDistance > 0) || (startDistance > 0 && endDistance < 0)) {
          clipped.push(start.clone().lerp(end, startDistance / (startDistance - endDistance)));
        }
      }
      polygon = clipped;
    }
    return polygon.length > 0;
  }

  async function capture(name, options = {}, attempt = 0) {
    const view = scene.views.find((v) => v.name === name);
    if (!view) throw new Error(`unknown view ${name}`);
    seedRandom(viewSeed(name, attempt));
    gtao.pdNoiseTexture.dispose();
    gtao.pdNoiseTexture = gtao._generateNoise();
    gtao.pdMaterial.uniforms.tNoise.value = gtao.pdNoiseTexture;
    renderer.setRenderTarget(null);
    renderer.shadowMap.type = THREE.VSMShadowMap;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    applyExplode(view.explode);
    const subject = new Set(view.subject ?? [...parts.keys()]);
    const isolated = view.isolated || options.isolated === true;
    for (const [id, part] of parts) {
      for (let i = 0; i < part.nodes.length; i += 1) part.nodes[i].visible = part.rest[i].visible;
      if (isolated && !subject.has(id)) {
        for (const node of part.nodes) node.visible = false;
      }
    }
    if (isolated) restOnFloor(view.subject[0]);
    const started = performance.now();
    const subjectMeshes = [...subject].flatMap((id) => {
      if (!parts.has(id)) throw new Error(`view ${name}: unknown occurrence ${id}`);
      return parts.get(id).meshes;
    });
    const sceneBox = new THREE.Box3().makeEmpty();
    subjectMeshes.forEach((mesh) => sceneBox.expandByObject(mesh));
    const radius = stage(sceneBox, isolated ? name : Boolean(view.explode));
    const points = isolated ? isolatedFramingPoints(subjectMeshes) : framingPoints(subjectMeshes);
    const fit = fitCamera(camera, points, options.direction ?? view.direction, options.frameScale ?? 1,
      options.up ?? view.up);
    const floorInFrame = floorIntersectsFrustum();
    const subjectRadius = new THREE.Box3().setFromPoints(vertexSample(subjectMeshes)).getSize(new THREE.Vector3()).length() / 2;
    const aoRadius = subjectRadius * STUDIO.aoRadius;
    gtao.updateGtaoMaterial({ radius: aoRadius, thickness: aoRadius, distanceExponent: 1, distanceFallOff: 1, scale: 1 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    const renderFrame = () => {
      composer.render();
      copyCtx.drawImage(renderer.domElement, 0, 0);
      const pixels = copyCtx.getImageData(0, 0, width, height).data;
      const encodeStarted = performance.now();
      const png = copy.toDataURL("image/png");
      const encodeMs = performance.now() - encodeStarted;
      const { mask, floor } = renderMask(subject, options.ghost === true);
      return { pixels, png, mask, floor, encodeMs };
    };
    const finalFrame = isolated
      ? withIsolatedSubject(subject, renderFrame)
      : (options.ghost ? withGhostContext(subject, renderFrame) : renderFrame());
    const visibleSubjectPixels = finalFrame.mask.reduce((count, cls) => count + (cls === 2), 0);
    const isolatedMask = view.subject ? withIsolatedSubject(subject, () => renderMask(subject).mask) : finalFrame.mask;
    const isolatedSubjectPixels = isolatedMask.reduce((count, cls) => count + (cls === 2), 0);
    const { mask, floor, pixels, png, encodeMs } = finalFrame;
    return {
      view: name,
      width,
      height,
      png,
      rgba: toBase64(new Uint8Array(pixels.buffer)),
      mask: toBase64(mask),
      floor: toBase64(floor),
      camera: cameraRecord(camera, fit.target),
      subject: [...subject],
      visible_subject_fraction: isolatedSubjectPixels ? visibleSubjectPixels / isolatedSubjectPixels : 0,
      floor_in_frame: floorInFrame,
      explode: Boolean(view.explode),
      scene_radius_m: radius,
      render_ms: Math.round(performance.now() - started),
      encode_ms: Math.round(encodeMs),
    };
  }
  // Motion frames (cad-motion motion.py through render.py --motion). A frame moves every occurrence
  // by a rigid delta from the version's built pose, in GLB metres: node world = delta x built world.
  // One camera serves a whole group of frames, fitted to the bounds the group sweeps, so the framing
  // holds still while the parts move. The floor shadow is a 128-map bake per pose, so motion frames
  // leave the floor out; the key light still shades the parts onto each other.
  const unitScale = new THREE.Vector3(1, 1, 1);
  const allMeshes = [...parts.values()].flatMap((part) => part.meshes);

  function depth(node) {
    let count = 0;
    for (let parent = node.parent; parent; parent = parent.parent) count += 1;
    return count;
  }

  function poseMotion(deltas) {
    applyExplode(false);
    const placed = [];
    for (const [id, part] of parts) {
      const delta = deltas[id];
      if (!delta) throw new Error(`motion frame is missing occurrence ${id}`);
      const move = new THREE.Matrix4().compose(new THREE.Vector3(...delta.translation),
        new THREE.Quaternion(...delta.quaternion), unitScale);
      for (const node of part.nodes) placed.push([node, move.clone().multiply(node.matrixWorld)]);
    }
    placed.sort((a, b) => depth(a[0]) - depth(b[0]));
    for (const [node, world] of placed) {
      node.parent.updateWorldMatrix(true, false);
      node.matrix.copy(node.parent.matrixWorld.clone().invert().multiply(world));
      node.matrix.decompose(node.position, node.quaternion, node.scale);
      node.updateMatrixWorld(true);
    }
    root.updateMatrixWorld(true);
  }

  // The world corners of every mesh's bounding box at the current pose.
  function boundsCorners() {
    const points = [];
    for (const mesh of allMeshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const { min, max } = mesh.geometry.boundingBox;
      for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
        points.push(new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld));
      }
    }
    return points;
  }

  function motionCamera(poses, direction, seed) {
    const points = [];
    let partRadius = 0;
    poses.forEach((deltas, i) => {
      poseMotion(deltas);
      const corners = boundsCorners();
      if (i === 0) partRadius = new THREE.Box3().setFromPoints(corners).getSize(new THREE.Vector3()).length() / 2;
      points.push(...corners);
    });
    const box = new THREE.Box3().setFromPoints(points);
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    aimLights(box.getCenter(new THREE.Vector3()), radius);
    ground.visible = false;
    const fit = fitCamera(camera, points, direction);
    seedRandom(viewSeed(seed, 0));
    gtao.pdNoiseTexture.dispose();
    gtao.pdNoiseTexture = gtao._generateNoise();
    gtao.pdMaterial.uniforms.tNoise.value = gtao.pdNoiseTexture;
    const aoRadius = partRadius * STUDIO.aoRadius;
    gtao.updateGtaoMaterial({ radius: aoRadius, thickness: aoRadius, distanceExponent: 1, distanceFallOff: 1, scale: 1 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    return { ...cameraRecord(camera, fit.target), swept_radius_m: radius };
  }

  // Renders one frame with the current group camera; `check` also returns each occurrence's first
  // node world placement for render.py's parity check.
  function captureMotion(deltas, check = false) {
    poseMotion(deltas);
    renderer.setRenderTarget(null);
    renderer.shadowMap.type = THREE.VSMShadowMap;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    composer.render();
    copyCtx.drawImage(renderer.domElement, 0, 0);
    const world = {};
    if (check) {
      for (const [id, part] of parts) {
        world[id] = { translation: part.nodes[0].getWorldPosition(new THREE.Vector3()).toArray(),
                      quaternion: part.nodes[0].getWorldQuaternion(new THREE.Quaternion()).toArray() };
      }
    }
    return { png: copy.toDataURL("image/png"), world };
  }

  // A grid of frame tiles, each captioned with two lines of text.
  async function contactSheet(tiles, columns, tileWidth) {
    const tileHeight = Math.round((tileWidth * height) / width);
    const caption = 34;
    const gap = 8;
    const rows = Math.ceil(tiles.length / columns);
    const sheet = document.createElement("canvas");
    sheet.width = columns * tileWidth + (columns + 1) * gap;
    sheet.height = rows * (tileHeight + caption) + (rows + 1) * gap;
    const ctx = sheet.getContext("2d");
    ctx.fillStyle = token("--color-backdrop");
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    for (const [i, tile] of tiles.entries()) {
      const image = new Image();
      image.src = tile.png;
      await image.decode();
      const x = gap + (i % columns) * (tileWidth + gap);
      const y = gap + Math.floor(i / columns) * (tileHeight + caption + gap);
      ctx.drawImage(image, x, y, tileWidth, tileHeight);
      ctx.fillStyle = token("--color-fg");
      ctx.font = `600 12px ${token("--font-ui") || "sans-serif"}`;
      ctx.fillText(tile.lines[0], x + 2, y + tileHeight + 14, tileWidth - 4);
      ctx.font = "11px monospace";
      ctx.fillText(tile.lines[1], x + 2, y + tileHeight + 29, tileWidth - 4);
    }
    return { png: sheet.toDataURL("image/png"), width: sheet.width, height: sheet.height, tiles: tiles.length };
  }

  setStatus("ready", "Ready");
  return {
    capture,
    motionCamera,
    captureMotion,
    measureVisibility,
    contactSheet,
    info: {
      three: THREE.REVISION,
      parts: [...parts.keys()],
      unmapped_meshes: unmapped,
      ground_y_m: groundY,
      // The material each PN is drawn in, read back from three.js: render.json materials.<PN>.applied.
      materials: Object.fromEntries([...parts.values()].map((part) => [part.pn, readBack(part.material)])),
      studio: {
        ...STUDIO,
        toneMapping: "ACESFilmic",
        outputColorSpace: renderer.outputColorSpace,
        environment: "RoomEnvironment",
        ambientOcclusion: "GTAOPass",
        shadowMap: "VSMShadowMap",
        floorShadow: "baked softbox occlusion",
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
  capture: async (name, options, attempt) => (await ready).capture(name, options, attempt),
  motionCamera: async (poses, direction, seed) => (await ready).motionCamera(poses, direction, seed),
  captureMotion: async (deltas, check) => (await ready).captureMotion(deltas, check),
  contactSheet: async (tiles, columns, tileWidth) => (await ready).contactSheet(tiles, columns, tileWidth),
  measureVisibility: async (check) => (await ready).measureVisibility(check),
};
