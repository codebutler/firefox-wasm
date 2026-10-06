// Runs inside each MODULARIZE factory, before worker allocation/instantiation.
// Gecko has no safe synchronous XPCOM shutdown from the embedding thread. Stop
// the runtime as a unit: never free a heap that a terminating pthread may use.
if (!ENVIRONMENT_IS_PTHREAD) {
  Module.geckoCleanup = [];
  Module.geckoDisposed = false;
  Module.geckoDispose = function () {
    if (Module.geckoDisposed) return;
    Module.geckoDisposed = true;
    var workerCount = typeof PThread === 'undefined' ? 0
      : Object.keys(PThread.pthreads).length + PThread.unusedWorkers.length;
    var attempt = function (fn) {
      try { fn(); } catch (error) { console.warn('[gecko-lifecycle] cleanup failed', error); }
    };
    // Detach native producers first. terminateRuntime also releases the main
    // thread's Atomics.waitAsync mailbox, which otherwise retains the heap.
    attempt(function () {
      if (typeof PThread === 'undefined') return;
      if (runtimeInitialized) PThread.terminateRuntime();
      else PThread.terminateAllThreads();
    });
    ABORT = true;
    for (var cleanup of Module.geckoCleanup.splice(0).reverse()) attempt(cleanup);
    if (typeof WISP !== 'undefined') attempt(function () { WISP.dispose(); });
    if (typeof JSEvents !== 'undefined') attempt(function () { JSEvents.removeAllEventListeners(); });
    if (typeof GL !== 'undefined') {
      for (var context of Object.values(GL.contexts || {})) {
        if (context) attempt(function () { GL.deleteContext(context.handle); });
      }
      GL.offscreenCanvases = {};
    }
    if (typeof specialHTMLTargets !== 'undefined') {
      delete specialHTMLTargets['#screen'];
      delete specialHTMLTargets.screen;
    }
    if (Module.ENV && Module.ENV.GECKO_LIFECYCLE_DEBUG) {
      console.info('[gecko-lifecycle] runtime disposed', { workers: workerCount });
    }
    Module.canvas = null;
    Module.geckoProviders = {};
    for (var key of ['geckoOnPresent', 'geckoOnLocationChange', 'geckoOnContextMenu',
      'geckoOnNewWindow', 'geckoOnPrompt', 'geckoOnPicker', 'geckoCancelPicker']) Module[key] = function () {};
  };
}
