// Load the game's vehicle .glb files in Node (no DOM): strip the embedded textures from the glTF
// JSON (Node can't decode images), parse the rest with three's GLTFLoader and register the scene
// with src/art/assets.js, so VehicleView builds the same glTF body it does in the browser.
import fs from 'fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { registerAsset } from '../../src/art/assets.js';

function stripTextures(buf) {
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  delete json.images; delete json.textures; delete json.samplers;
  for (const m of json.materials || []) {
    const pbr = m.pbrMetallicRoughness || {};
    delete pbr.baseColorTexture; delete pbr.metallicRoughnessTexture;
    delete m.normalTexture; delete m.emissiveTexture; delete m.occlusionTexture;
  }
  let js = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (js.length % 4)) % 4;
  js = Buffer.concat([js, Buffer.alloc(pad, 0x20)]);
  const rest = buf.subarray(20 + jsonLen); // BIN chunk (header + data)
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + js.length + rest.length, 8);
  head.writeUInt32LE(js.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const out = Buffer.concat([head, js, rest]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

export async function loadVehicleGlb(id, dir = new URL('../../public/models/vehicles/', import.meta.url)) {
  const buf = fs.readFileSync(new URL(`${id}.glb`, dir));
  const gltf = await new GLTFLoader().parseAsync(stripTextures(buf), '');
  registerAsset('vehicles/' + id, gltf.scene);
  return gltf.scene;
}

export async function loadAllVehicles(ids = ['taco', 'lc70', 'wrx']) {
  for (const id of ids) await loadVehicleGlb(id);
}
