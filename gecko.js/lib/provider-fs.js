// JS hooks for the provider-backed WasmFS backend (emsdk-patches/provider_backend.h).
//
// The C++ ProviderBackend proxies each I/O op to the runtime main thread R via
// ProxyingQueue::proxySyncWithCtx; these functions run THERE (so no __proxy
// here) and call the consumer's async FsProvider, then _emscripten_proxy_finish
// to unblock the calling Gecko worker. Module.geckoProviders[mountId] is the
// mount-relative-wrapped provider, set by index.ts. outErr is a flag (0 ok /
// nonzero fail); the C++ maps nonzero to -EIO.
//
// Naming: keys = C symbol names verbatim (no leading underscore), like the WISP
// hooks. _provider_record_entry is an exported C function (EXPORTED_FUNCTIONS).

mergeInto(LibraryManager.library, {
  $geckoProv: (mountId) => (typeof Module !== 'undefined' && Module.geckoProviders) ? Module.geckoProviders[mountId] : undefined,

  // A host provider can outlive Gecko. Race its promise against disposal so
  // its continuation releases this runtime even if the provider never settles.
  $geckoProviderAwait: async function (work) {
    if (Module.geckoDisposed) return;
    var cancel;
    var closed = new Promise(function (resolve) { cancel = function () { resolve(); }; });
    Module.geckoCleanup.push(cancel);
    try { return await Promise.race([work, closed]); }
    finally {
      var index = Module.geckoCleanup.indexOf(cancel);
      if (index >= 0) Module.geckoCleanup.splice(index, 1);
    }
  },

  provider_stat__deps: ['emscripten_proxy_finish', '$UTF8ToString', '$geckoProv', '$geckoProviderAwait'],
  provider_stat: async function (ctx, mountId, pathPtr, outExists, outIsDir, outSize) {
    if (Module.geckoDisposed) return;
    let exists = 0, isDir = 0, size = 0;
    try {
      const st = await geckoProviderAwait(geckoProv(mountId).stat(UTF8ToString(pathPtr)));
      if (st) { exists = 1; isDir = st.isDir ? 1 : 0; size = st.size || 0; }
    } catch (e) {}
    if (Module.geckoDisposed) return;
    HEAP32[outExists >> 2] = exists;
    HEAP32[outIsDir >> 2] = isDir;
    HEAPU32[outSize >> 2] = size >>> 0;
    HEAPU32[(outSize >> 2) + 1] = Math.floor(size / 4294967296);
    _emscripten_proxy_finish(ctx);
  },

  provider_read__deps: ['emscripten_proxy_finish', '$UTF8ToString', '$geckoProv', '$geckoProviderAwait', 'malloc'],
  provider_read: async function (ctx, mountId, pathPtr, outPtr, outLen, outErr) {
    if (Module.geckoDisposed) return;
    let p = 0, n = 0, err = 0;
    try {
      const data = await geckoProviderAwait(geckoProv(mountId).readFile(UTF8ToString(pathPtr)));
      if (Module.geckoDisposed) return;
      n = data.length;
      if (n > 0) { p = _malloc(n); HEAPU8.set(data, p); }
    } catch (e) { err = 1; }
    if (Module.geckoDisposed) return;
    HEAPU32[outPtr >> 2] = p;
    HEAP32[outLen >> 2] = n;
    HEAP32[outErr >> 2] = err;
    _emscripten_proxy_finish(ctx);
  },

  provider_write__deps: ['emscripten_proxy_finish', '$UTF8ToString', '$geckoProv', '$geckoProviderAwait'],
  provider_write: async function (ctx, mountId, pathPtr, dataPtr, len, outErr) {
    if (Module.geckoDisposed) return;
    let err = 0;
    try {
      // Copy out of the heap (the provider call is async; the heap may move/grow).
      await geckoProviderAwait(geckoProv(mountId).writeFile(UTF8ToString(pathPtr), HEAPU8.slice(dataPtr, dataPtr + len)));
    } catch (e) { err = 1; }
    if (Module.geckoDisposed) return;
    HEAP32[outErr >> 2] = err;
    _emscripten_proxy_finish(ctx);
  },

  provider_readdir__deps: ['emscripten_proxy_finish', '$UTF8ToString', '$stringToUTF8OnStack', '$stackSave', '$stackRestore', '$geckoProv', '$geckoProviderAwait'],
  provider_readdir: async function (ctx, mountId, pathPtr, entriesVec, outErr) {
    if (Module.geckoDisposed) return;
    let err = 0;
    try {
      const prov = geckoProv(mountId);
      const dir = UTF8ToString(pathPtr);
      const names = await geckoProviderAwait(prov.readdir(dir));
      if (Module.geckoDisposed) return;
      for (const name of names) {
        let isDir = 0;
        try { const st = await geckoProviderAwait(prov.stat(dir ? dir + '/' + name : name)); if (st && st.isDir) isDir = 1; } catch (e) {}
        if (Module.geckoDisposed) return;
        const sp = stackSave();
        _provider_record_entry(entriesVec, stringToUTF8OnStack(name), isDir);
        stackRestore(sp);
      }
    } catch (e) { err = 1; }
    if (Module.geckoDisposed) return;
    HEAP32[outErr >> 2] = err;
    _emscripten_proxy_finish(ctx);
  },

  provider_mkdir__deps: ['emscripten_proxy_finish', '$UTF8ToString', '$geckoProv', '$geckoProviderAwait'],
  provider_mkdir: async function (ctx, mountId, pathPtr, outErr) {
    if (Module.geckoDisposed) return;
    let err = 0;
    try { await geckoProviderAwait(geckoProv(mountId).mkdir(UTF8ToString(pathPtr))); } catch (e) { err = 1; }
    if (Module.geckoDisposed) return;
    HEAP32[outErr >> 2] = err;
    _emscripten_proxy_finish(ctx);
  },

  provider_unlink__deps: ['emscripten_proxy_finish', '$UTF8ToString', '$geckoProv', '$geckoProviderAwait'],
  provider_unlink: async function (ctx, mountId, pathPtr, outErr) {
    if (Module.geckoDisposed) return;
    let err = 0;
    try { await geckoProviderAwait(geckoProv(mountId).unlink(UTF8ToString(pathPtr))); } catch (e) { err = 1; }
    if (Module.geckoDisposed) return;
    HEAP32[outErr >> 2] = err;
    _emscripten_proxy_finish(ctx);
  },

  provider_rename__deps: ['emscripten_proxy_finish', '$UTF8ToString', '$geckoProv', '$geckoProviderAwait'],
  provider_rename: async function (ctx, mountId, fromPtr, toPtr, outErr) {
    if (Module.geckoDisposed) return;
    let err = 0;
    try { await geckoProviderAwait(geckoProv(mountId).rename(UTF8ToString(fromPtr), UTF8ToString(toPtr))); } catch (e) { err = 1; }
    if (Module.geckoDisposed) return;
    HEAP32[outErr >> 2] = err;
    _emscripten_proxy_finish(ctx);
  },
});
