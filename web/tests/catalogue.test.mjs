import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCatalogue } from '../src/catalogue.ts';

// Transport fixtures only: these bytes are never written to /data or rendered.
function fixture() {
  const attributes = {};
  for (const name of ['position', 'midpoint', 'color', 'brightness', 'unbounded']) {
    const floats = name === 'position' || name === 'midpoint';
    attributes[name] = {
      file: `${name}.bin`, byte_offset: 0, byte_length: floats ? 24 : 2,
      dtype: floats ? '<f4' : '<u1', bytes_per_component: floats ? 4 : 1,
      item_size: floats ? 3 : 1, count: 2, normalized: false,
    };
  }
  return {
    stage: 'pack', byte_order: 'little-endian', stars: 1, vertices: 2,
    bounding_radius_pc: 1, attributes,
    decode: {
      color: { sentinel: 0, domain: [-0.5, 5.5] },
      brightness: { sentinel: 0, domain: [2, 22], inverted: true },
      unbounded: { codes: { 0: 'measured', 1: 'clamped', 2: 'unbounded' } },
    },
  };
}

test('five streams start concurrently, progress counts bytes, scalar codes stay raw', async (t) => {
  const meta = fixture();
  const streams = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/data/meta.json') return Response.json(meta);
    const name = url.split('/').at(-1).replace('.bin', '');
    return new Response(new ReadableStream({ start(controller) {
      streams.push({ controller, bytes: meta.attributes[name].byte_length });
      if (streams.length === 5) {
        for (const { controller, bytes } of streams) {
          controller.enqueue(new Uint8Array(bytes / 2));
          controller.enqueue(new Uint8Array(bytes / 2));
          controller.close();
        }
      }
    } }));
  });
  const updates = [];
  const { geometry } = await loadCatalogue((loaded, total) => updates.push([loaded, total]));
  assert.equal(streams.length, 5);
  assert.deepEqual(updates[0], [0, 54]);
  assert.deepEqual(updates.at(-1), [54, 54]);
  assert.ok(updates.every(([loaded], i) => i === 0 || loaded > updates[i - 1][0]));
  assert.equal(geometry.getAttribute('position').count, 2);
  assert.ok(geometry.getAttribute('position').array instanceof Float32Array);
  // Renamed off the packer's key: `color` is a scalar bp_rp code, and Three.js
  // reserves that attribute name for RGB vertex colours.
  assert.equal(geometry.getAttribute('color'), undefined);
  assert.ok(geometry.getAttribute('bpRpCode').array instanceof Uint8Array);
  assert.equal(geometry.getAttribute('bpRpCode').normalized, false);
  assert.equal(geometry.getAttribute('magCode').count, 2);
  assert.equal(geometry.getAttribute('farFlag').count, 2);
  assert.equal(geometry.boundingSphere.radius, 1);
  geometry.dispose();
});

test('truncated attributes fail and abort remaining downloads', async (t) => {
  let signal;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    signal = options.signal;
    return url === '/data/meta.json' ? Response.json(fixture()) : new Response(new Uint8Array(1));
  });
  await assert.rejects(loadCatalogue(() => {}), /expected .* bytes, received 1/);
  assert.equal(signal.aborted, true);
});

test('wrong attribute layout fails before binary downloads', async (t) => {
  const meta = fixture();
  meta.attributes.color.item_size = 3;
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(meta));
  await assert.rejects(loadCatalogue(() => {}), /Invalid color/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('Vite HTML fallback is reported as missing catalogue', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html></html>', {
    headers: { 'content-type': 'text/html' },
  }));
  await assert.rejects(loadCatalogue(() => {}), /No \/data\/meta.json found/);
});

test('a manifest without usable decode rules fails before binary downloads', async (t) => {
  const meta = fixture();
  delete meta.decode.brightness.inverted;
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(meta));
  await assert.rejects(loadCatalogue(() => {}), /Unsupported catalogue decode rules/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('a missing-measurement sentinel that moved is rejected', async (t) => {
  const meta = fixture();
  meta.decode.color.sentinel = 255;
  t.mock.method(globalThis, 'fetch', async () => Response.json(meta));
  await assert.rejects(loadCatalogue(() => {}), /Unsupported catalogue decode rules/);
});
