// The wrapper statically imports gecko-engine.mjs. Its pthread entrypoint
// imports that same factory; no JavaScript source strings are evaluated.
// gecko.data remains inlined as binary data, and the wasm is consumer-served.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rspack from '@rspack/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasm = (f) => path.resolve(here, 'wasm', f);

export default {
  target: 'web',
  externalsType: 'module',
  externals: { '../wasm/gecko-engine.mjs': './gecko-engine.mjs' },
  mode: 'production',
  entry: './js/index.ts',
  experiments: { outputModule: true },
  output: {
    path: path.resolve(here, 'dist'),
    filename: 'gecko.js',
    library: { type: 'module' },
    module: true,
    clean: false,
  },
  resolve: { extensions: ['.ts', '.js', '.mjs'] },
  module: {
    parser: { javascript: { url: false, importMeta: false } },
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'builtin:swc-loader',
          options: { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' } },
        },
      },
      // `import x from './gecko.js?source'` -> the file's text, inlined in the bundle.
      { resourceQuery: /source/, type: 'asset/source' },
      // `import uri from './gecko.data.zst?inline'` -> base64 data: URI, inlined.
      // .zst has no entry in the mimetype DB, so set one explicitly (the value is
      // irrelevant -- the loader fetch()es the data: URI for its bytes).
      { resourceQuery: /inline/, type: 'asset/inline', generator: { dataUrl: { mimetype: 'application/octet-stream', encoding: 'base64' } } },
    ],
  },
  plugins: [
    new rspack.CopyRspackPlugin({
      patterns: [
        { from: wasm('gecko-engine.mjs'), to: 'gecko-engine.mjs' },
        // gecko.js + gecko.worker.js (asset/source) and gecko.data.zst (asset/inline,
        // zstd) + gecko-assets.json (JSON import) are all INLINED into the bundle.
        // The only artifact the consumer serves is the wasm: raw gecko.wasm in debug,
        // or gecko.wasm.zst in RELEASE (still too big to inline; decoded by the loader).
        ...(process.env.GECKO_RELEASE === '1'
          ? [{ from: wasm('gecko.wasm.zst'), to: 'gecko.wasm.zst', noErrorOnMissing: true }]
          : [{ from: wasm('gecko.wasm'), to: 'gecko.wasm', noErrorOnMissing: true }]),
      ],
    }),
  ],
  optimization: { minimize: false },
};
