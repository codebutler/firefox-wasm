// Execute the installed Emscripten GL string-query implementations against
// multiple contexts. This catches cross-context version/extension leakage.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = process.argv[2] || join(process.env.EMSDK, 'upstream/emscripten');
function implementation(file, name) {
  const source = readFileSync(join(root, 'src/lib', file), 'utf8');
  const start = source.indexOf('  ' + name + ':');
  assert(start >= 0, 'Missing ' + name);
  const end = source.indexOf('\n  },', start);
  const lines = source.slice(start, end + 5).split('\n');
  const conditions = {
    GL_EMULATE_GLES_VERSION_STRING_FORMAT: true,
    '!GL_EMULATE_GLES_VERSION_STRING_FORMAT': false,
    'MAX_WEBGL_VERSION >= 2': true,
    GL_TRACK_ERRORS: true,
    GL_ASSERTIONS: false,
  };
  const stack = [true];
  const output = [];
  for (const line of lines) {
    if (line.startsWith('#if ')) {
      const condition = line.slice(4).trim();
      assert(Object.hasOwn(conditions, condition), 'Unknown preprocessor condition: ' + condition);
      stack.push(stack.at(-1) && conditions[condition]);
    } else if (line.startsWith('#endif')) stack.pop();
    else if (line.startsWith('#')) throw new Error('Unexpected preprocessor directive: ' + line);
    else if (stack.at(-1)) output.push(line);
  }
  assert.equal(stack.length, 1);
  return output.join('\n').replaceAll('{{{ isCurrentContextWebGL2() }}}', 'GL.currentContext.version >= 2');
}
const GL = { currentContext: null, stringCache: {}, stringiCache: {}, recordError: code => { throw new Error('GL error ' + code); } };
const sandbox = {
  GL,
  GLctx: { getParameter: name => name === 0x1f02 ? `WebGL ${GL.currentContext.version}.0` : 'WebGL GLSL ES 3.00' },
  stringToNewUTF8: value => value,
  webglGetExtensions: () => GL.currentContext.extensions,
};
const api = vm.runInNewContext('({' + implementation('libwebgl.js', 'glGetString') + implementation('libwebgl2.js', 'glGetStringi') + '})', sandbox);
for (const order of [[1, 2], [2, 1]]) {
  const contexts = order.map(version => ({ version, extensions: ['version_' + version] }));
  contexts.push({ version: 2, extensions: ['another_context'] });
  for (const context of [...contexts, ...contexts.toReversed()]) {
    GL.currentContext = context;
    assert.match(api.glGetString(0x1f02), context.version === 1 ? /OpenGL ES 2\.0/ : /OpenGL ES 3\.0/);
    assert.equal(api.glGetString(0x1f03), context.extensions.join(' '));
    if (context.version === 2) assert.equal(api.glGetStringi(0x1f03, 0), context.extensions[0]);
  }
}
console.log('GL version and extension queries stay isolated across context types and creation orders');
