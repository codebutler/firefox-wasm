// Execute the installed Emscripten GL string-query implementations against
// multiple contexts. This catches cross-context version/extension leakage.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = process.argv[2] || join(process.env.EMSDK, 'upstream/emscripten');
function implementation(file, name) {
  const source = readFileSync(join(root, 'src/lib', file), 'utf8');
  const start = source.search(new RegExp('  ' + name + '\\s*:'));
  assert(start >= 0, 'Missing ' + name);
  const end = source.indexOf('\n  },', start);
  const lines = source.slice(start, end + 5).split('\n');
  const conditions = {
    GL_EMULATE_GLES_VERSION_STRING_FORMAT: true,
    '!GL_EMULATE_GLES_VERSION_STRING_FORMAT': false,
    'MAX_WEBGL_VERSION >= 2': true,
    GL_TRACK_ERRORS: true,
    GL_ASSERTIONS: false,
    'GL_ASSERTIONS || GL_TRACK_ERRORS': true,
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
  return output.join('\n')
    .replaceAll('{{{ isCurrentContextWebGL2() }}}', 'GL.currentContext.version >= 2')
    .replace(/\{\{\{ makeSetValue\('p', '0', '([^']+)', 'i32'\) \}\}\}/g, 'HEAP32[p >> 2] = $1');
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

const calls = [];
const program = { varyings: ['short', 'longer_varying_name'] };
GL.programs = [null, program];
GL.counter = 2;
sandbox.HEAP32 = new Int32Array(4);
sandbox.GLctx.enable = cap => calls.push(cap);
sandbox.GLctx.getProgramParameter = (p, name) => {
  assert.equal(name, 0x8c83, 'Do not pass the unsupported MAX_LENGTH query through');
  return p.varyings.length;
};
sandbox.GLctx.getTransformFeedbackVarying = (p, i) => ({ name: p.varyings[i] });
const gles = vm.runInNewContext('({' + implementation('libwebgl.js', 'glEnable') + implementation('libwebgl.js', 'glGetProgramiv') + '})', sandbox);
GL.currentContext = { version: 2 };
gles.glEnable(0x8d69);
assert.equal(calls.length, 0);
gles.glEnable(0x0b71); // depth test still reaches the host
assert.deepEqual(calls, [0x0b71]);
gles.glGetProgramiv(1, 0x8c76, 4);
assert.equal(sandbox.HEAP32[1], 'longer_varying_name'.length + 1);
program.varyings = [];
gles.glGetProgramiv(1, 0x8c76, 4);
assert.equal(sandbox.HEAP32[1], 0);
GL.currentContext = { version: 1 };
assert.throws(() => gles.glGetProgramiv(1, 0x8c76, 4), /GL error/);
console.log('GLES3 primitive restart and transform-feedback name queries adapt to WebGL2');
