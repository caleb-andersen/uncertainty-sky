import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';

// Manifest key -> wire format and the name the shader binds it under. The
// scalar channels are renamed on the way in: `color` is a quantised bp_rp code
// rather than an RGB triple, and Three.js reserves that attribute name for
// vertex colours. Keeping the packer's name here would put a scalar in a slot
// the renderer may declare as a vec3.
const layout = {
  position: { dtype: '<f4', size: 3, bytes: 4, attribute: 'position' },
  midpoint: { dtype: '<f4', size: 3, bytes: 4, attribute: 'midpoint' },
  color: { dtype: '<u1', size: 1, bytes: 1, attribute: 'bpRpCode' },
  brightness: { dtype: '<u1', size: 1, bytes: 1, attribute: 'magCode' },
  unbounded: { dtype: '<u1', size: 1, bytes: 1, attribute: 'farFlag' },
} as const;
type AttributeName = keyof typeof layout;

interface AttributeMeta {
  file: string;
  byte_offset: number;
  byte_length: number;
  dtype: string;
  bytes_per_component: number;
  item_size: number;
  count: number;
  normalized: boolean;
}
interface ChannelDecode {
  sentinel: number;
  domain: [number, number];
  inverted?: boolean;
}
interface Manifest {
  stage: string;
  byte_order: string;
  stars: number;
  vertices: number;
  bounding_radius_pc: number;
  attributes: Record<AttributeName, AttributeMeta>;
  decode: {
    color: ChannelDecode;
    brightness: ChannelDecode;
    unbounded: { codes: Record<string, string> };
  };
  // Written by pack.py's summary. Optional: the renderer quotes these counts in
  // its legend and simply omits the figure when a build predates them.
  stats?: {
    far_measured: number;
    far_clamped: number;
    far_unbounded: number;
    bp_rp_missing: number;
  };
}

function validDomain(channel: ChannelDecode | undefined): boolean {
  return !!channel && channel.sentinel === 0 && Array.isArray(channel.domain) &&
    channel.domain.length === 2 && channel.domain.every(Number.isFinite) &&
    channel.domain[0] < channel.domain[1];
}

// Reject incompatible/truncated exports rather than quietly drawing wrong geometry.
function validateManifest(value: Manifest): Manifest {
  if (!value || value.stage !== 'pack' || value.byte_order !== 'little-endian' ||
      !Number.isSafeInteger(value.stars) || value.stars <= 0 ||
      value.vertices !== value.stars * 2 ||
      !Number.isFinite(value.bounding_radius_pc) || value.bounding_radius_pc <= 0) {
    throw new Error('Unsupported or empty catalogue manifest. Re-run pipeline/pack.py.');
  }
  for (const name of Object.keys(layout) as AttributeName[]) {
    const attr = value.attributes?.[name];
    const { dtype, size, bytes } = layout[name];
    if (!attr || attr.file !== `${name}.bin` || attr.dtype !== dtype ||
        attr.item_size !== size || attr.bytes_per_component !== bytes ||
        attr.count !== value.vertices || attr.byte_offset !== 0 ||
        attr.byte_length !== value.vertices * size * bytes || attr.normalized !== false) {
      throw new Error(`Invalid ${name} attribute metadata. Re-run pipeline/pack.py.`);
    }
  }
  // The shader decodes these codes itself, so a packer that moved a domain or
  // dropped the missing-measurement sentinel has to fail loudly here rather
  // than silently recolour the sky.
  const decode = value.decode;
  if (!validDomain(decode?.color) || !validDomain(decode?.brightness) ||
      decode.brightness.inverted !== true ||
      !['0', '1', '2'].every((code) => code in (decode.unbounded?.codes ?? {}))) {
    throw new Error('Unsupported catalogue decode rules. Re-run pipeline/pack.py.');
  }
  // Typed-array views must agree with the packer's byte order.
  if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) {
    throw new Error('This catalogue requires a little-endian browser.');
  }
  return value;
}

async function streamAttribute(
  attr: AttributeMeta, signal: AbortSignal, advance: (bytes: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(`/data/${attr.file}`, { signal });
  if (!response.ok) throw new Error(`${attr.file}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`${attr.file}: response has no readable stream`);
  // Allocate once using the manifest; avoid retaining chunks plus a joined copy.
  const buffer = new ArrayBuffer(attr.byte_length);
  const destination = new Uint8Array(buffer);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > destination.byteLength) {
        throw new Error(`${attr.file}: more bytes than declared in meta.json`);
      }
      destination.set(value, offset);
      offset += value.byteLength;
      advance(value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== destination.byteLength) {
    throw new Error(`${attr.file}: expected ${destination.byteLength} bytes, received ${offset}`);
  }
  return buffer;
}

export async function loadCatalogue(onProgress: (loaded: number, total: number) => void) {
  const abort = new AbortController();
  const geometry = new BufferGeometry();
  try {
    const response = await fetch('/data/meta.json', { signal: abort.signal });
    if (!response.ok) throw new Error(`meta.json: HTTP ${response.status}`);
    if (response.headers.get('content-type')?.includes('text/html')) {
      throw new Error('No /data/meta.json found. Run the Gaia pipeline through pack.py first.');
    }
    const meta = validateManifest(await response.json());
    const names = Object.keys(layout) as AttributeName[];
    const total = names.reduce((sum, name) => sum + meta.attributes[name].byte_length, 0);
    let loaded = 0;
    onProgress(loaded, total);
    await Promise.all(names.map(async (name) => {
      const attr = meta.attributes[name];
      const buffer = await streamAttribute(attr, abort.signal, (bytes) => {
        loaded += bytes;
        onProgress(loaded, total);
      });
      const array = attr.dtype === '<f4' ? new Float32Array(buffer) : new Uint8Array(buffer);
      // Raw codes, unnormalised: the shader reads 0..255 and decodes with the
      // manifest's own rules, so the missing-measurement sentinel survives to
      // the point where it can be drawn as missing.
      geometry.setAttribute(
        layout[name].attribute, new BufferAttribute(array, attr.item_size, false));
    }));
    geometry.boundingSphere = new Sphere(new Vector3(), meta.bounding_radius_pc);
    return { geometry, meta };
  } catch (error) {
    abort.abort();
    geometry.dispose();
    throw error;
  }
}
