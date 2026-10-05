import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

// Exercise the actual loader with two bundles sharing one page, as happens
// when an installed disc is replaced without reloading the host application.
const source = readFileSync(new URL('./js/index.ts', import.meta.url), 'utf8');
const loader = stripTypeScriptTypes(source.slice(source.indexOf('const toBlobUrl ='), source.indexOf('interface Cmd {')));

test('each imported bundle retains its own factory across upgrades and concurrent loads', async () => {
  const blobs = new Map();
  const oldFactory = () => 'old disc';
  let removed = 0;
  const context = vm.createContext({
    Blob, crypto: { randomUUID }, createGecko: oldFactory,
    URL: {
      createObjectURL(blob) { const url = 'blob:' + randomUUID(); blobs.set(url, blob); return url; },
      revokeObjectURL(url) { blobs.delete(url); },
    },
    document: {
      createElement() { return { remove() { removed++; } }; },
      head: {
        async appendChild(script) {
          try { vm.runInContext(await blobs.get(script.src).text(), context); script.onload(); }
          catch { script.onerror(); }
        },
      },
    },
  });
  const load = version => vm.runInContext(`(function(){const geckoSource = ${JSON.stringify(`var createGecko = () => ${JSON.stringify(version)};`)};${loader};return loadEngine();})()`, context);
  const [first, second] = await Promise.all([load('candidate A'), load('candidate B')]);
  assert.equal(first(), 'candidate A');
  assert.equal(second(), 'candidate B');
  assert.equal(context.createGecko, oldFactory);
  assert.equal(blobs.size, 0);
  assert.equal(removed, 2);
  assert.deepEqual(Object.keys(context).filter(key => key.startsWith('__geckoFactory_')), []);
});
