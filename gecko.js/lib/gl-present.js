// JSPI present-yield for GPU mode. The WebRender Renderer thread owns #screen's
// transferred OffscreenCanvas and renders to it locally (no per-GL-call proxy); the
// browser implicit-presents that OffscreenCanvas to the #screen placeholder element
// whenever the owning worker yields to its event loop. But a Gecko thread runs a
// blocking message loop and never yields. GLContextEmscripten::SwapBuffers (libxul,
// gfx/gl/GLContextProviderEmscripten.cpp) calls gl_present_yield() to yield via JSPI:
//
//   __async: true  -> with the link's -sJSPI, emscripten wraps this as a suspending
//                     import, so the calling wasm stack (the Renderer thread) is
//                     suspended until the returned Promise resolves.
//   NO __proxy     -> it runs on the CALLING thread (the Renderer worker), so it is
//                     that worker's event loop that turns -- which is the one that
//                     implicit-presents ITS OffscreenCanvas.
//
// setTimeout(0) is a macrotask, so the worker reaches the rendering/update step (the
// present) before resolving; a microtask (Promise.resolve) would not. This replaces
// the old transferToImageBitmap -> postMessage -> #glout bitmaprenderer hack, so the
// page needs only the single #screen canvas.
// gl_present_yield is imported by GLContextEmscripten::SwapBuffers (libxul). It
// returns a Promise that resolves on the next macrotask. We do NOT mark it __async
// (that needs global -sJSPI); instead patch-gecko-shaderfix.mjs wraps THIS import
// with WebAssembly.Suspending and the proxy/mailbox executor exports with
// WebAssembly.promising, so ONLY this call suspends the (Renderer) thread -- one
// macrotask, during which the browser implicit-presents the OffscreenCanvas to the
// #screen placeholder. A normal (non-suspending) call here would just not yield.
//
// FIRST-PRESENT SIGNAL. An embedder cannot otherwise tell when pixels first reach
// the canvas: load() resolving means the DOCUMENT finished loading, and in GPU mode
// the compositor presents autonomously off the refresh driver. So a window shows a
// blank surface for as long as RenderThread's device init takes (seconds under
// software GL) with nothing to wait on, which reads as a broken window.
//
// This function is the one place that knows: the browser implicit-presents during
// the macrotask we yield for, so by the time the setTimeout callback runs, the FIRST
// frame is on screen. Report that once, to the main thread.
//
// It has to be reported cross-thread because this runs on the Renderer worker.
// CMD_CALL_HANDLER is emscripten's own worker->main path (libpthread.js's message
// handler does `Module[d.handler](...d.args)`), which is per-instance-correct: it
// lands on THIS module's main thread, so two embedded Gecko instances on one page
// don't cross wires. Emscripten also auto-proxies handlers, but only ones on its
// fixed knownHandlers list, so posting explicitly is what avoids patching the
// toolchain. gecko.js always defines the handler (that dispatch does not null-check).
mergeInto(LibraryManager.library, {
  gl_present_yield: function () {
    return new Promise(function (resolve) {
      setTimeout(function () {
        // Report the first few presents (index included) rather than only the
        // very first: the compositor's opening frame can be empty, so the
        // embedder -- not this function -- decides which present counts as
        // "there is something to look at". Capped so a long-running engine
        // isn't posting a message every frame forever.
        // PRESENT_REPORT_CAP -- MUST stay in sync with js/index.ts, which treats
        // reaching it as "resolve firstPaint anyway". Reporting is a startup
        // concern, so it stops afterwards rather than posting a message per frame
        // for the life of the engine; the cap is generous enough (~10s at 60fps)
        // that a first load never reaches it in practice, and if one somehow did,
        // the embedder resolves instead of waiting forever.
        var n = (Module['__geckoPresentCount'] || 0) + 1;
        Module['__geckoPresentCount'] = n;
        if (n <= 600 && typeof postMessage === 'function') {
          postMessage({
            cmd: {{{ CMD_CALL_HANDLER }}},
            handler: 'geckoOnPresent',
            args: [n],
          });
        }
        resolve();
      }, 0);
    });
  },
});
