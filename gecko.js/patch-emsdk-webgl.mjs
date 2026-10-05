#!/usr/bin/env node
// Emscripten 6.0.1 caches GL strings across contexts on each worker. Gecko
// creates both ES2 and ES3 content contexts on the same thread, so the first
// context's version/extensions incorrectly determine every later context.
// Patch source before linking; fail on drift and always start from pristine.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || (process.env.EMSDK && join(process.env.EMSDK, 'upstream/emscripten'));
if (!root) throw new Error('Set EMSDK or pass the Emscripten source directory');
for (const [file, field] of [['libwebgl.js', 'stringCache'], ['libwebgl2.js', 'stringiCache']]) {
  const path = join(root, 'src/lib', file);
  const pristine = path + '.gecko-orig';
  if (!existsSync(pristine)) copyFileSync(path, pristine);
  let source = readFileSync(pristine, 'utf8');
  const anchor = field === 'stringCache' ? '  glGetString: (name_) => {' : '  glGetStringi: (name, index) => {';
  if (!source.includes(anchor) || !source.includes('GL.' + field + '[')) {
    throw new Error(file + ': GL string-cache source changed; review the patch');
  }
  source = source.replace(anchor, anchor + '\n    var ' + field + ' = GL.currentContext.' + field + ' ||= {};');
  source = source.replaceAll('GL.' + field + '[', field + '[');
  // glGetStringi already uses stringiCache for the returned extension array.
  if (field === 'stringiCache') {
    source = source.replace('var stringiCache = GL.currentContext.stringiCache ||= {};',
      'var contextStringiCache = GL.currentContext.stringiCache ||= {};')
      .replaceAll('stringiCache[name]', 'contextStringiCache[name]');
  }
  writeFileSync(path, source);
  console.log('Scoped ' + file + ' GL strings to their owning context');
}
