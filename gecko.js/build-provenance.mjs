// Record the source and binary identities of a candidate before packaging it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const digest = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const makefile = readFileSync(resolve(root, 'Makefile'), 'utf8');
const engineCommit = makefile.match(/^FIREFOX_REF\s*:=\s*([0-9a-f]{40})$/m)?.[1];
if (!engineCommit) throw new Error('Expected an exact FIREFOX_REF commit');
const files = readdirSync(resolve(root, 'gecko.js/dist')).filter(name => /^(gecko\.js|gecko\.wasm(?:\.zst)?|gecko-assets\.json)$/.test(name));
if (!files.includes('gecko.js') || !files.some(name => /^gecko\.wasm/.test(name))) throw new Error('Missing runnable engine artifacts');
const sourcePaths = [
  ...readdirSync(resolve(root, 'patches')).filter(name => name.endsWith('.patch')).map(name => 'patches/' + name),
  'gecko.js/patch-emsdk-webgl.mjs', 'gecko.js/patch-emsdk-wasmfs.mjs',
];
const provenance = {
  schema: 1,
  wrapper: { repository: 'https://github.com/codebutler/firefox-wasm', commit: git('rev-parse', 'HEAD') },
  engine: { repository: 'https://github.com/HeyPuter/firefox', commit: engineCommit },
  sources: Object.fromEntries(sourcePaths.sort().map(path => [path, digest(path)])),
  tools: { emscripten: process.env.EMSDK_VERSION, rust: process.env.RUST_VERSION, pnpm: process.env.PNPM_VERSION },
  optimized: process.env.NO_WASM_OPT !== '1',
  build: { run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT },
  files: Object.fromEntries(files.sort().map(name => [name, { bytes: readFileSync(resolve(root, 'gecko.js/dist', name)).length, sha256: digest('gecko.js/dist/' + name) }])),
};
writeFileSync(resolve(root, 'gecko.js/dist/gecko-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
