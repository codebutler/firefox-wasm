# Runtime lifetime

`Gecko.destroy()` is terminal and idempotent. It cancels initialization/fetches,
settles queued and active commands, withdraws pickers, stops paint polling and
input listeners, revokes its worker script URL, and drops its Wasm module.
Embedders must call it even when `init()` is still pending. Create a new instance
and canvas to start again; a transferred canvas cannot be reused.

`runtime-lifecycle.js` is linked inside each Emscripten factory. Its teardown
terminates all allocated pthreads and the main-thread mailbox wait, closes
custom TCP/WISP streams, removes runtime input listeners and GL contexts, and
runs per-instance cleanup for clocks, audio/worklets and host media decoders.
Pending media callbacks must not access the heap after teardown. The coarse
clock and cubeb audio state are module-owned, so closing one browser cannot
stop another browser's resources.

This is a terminal runtime stop, not a graceful Gecko/XPCOM shutdown. Do not
free pthread structures while worker termination may still be in progress;
release the entire runtime for garbage collection. Already-written OPFS data
remains; no guarantee is made about flushing pending Gecko application state.

`GECKO_LIFECYCLE_DEBUG=1` logs runtime disposal and its worker count without
URLs or page content. `node --test gecko.js/*.test.mjs` includes cancellation,
command settlement, per-instance clock ownership and late socket callbacks.
The Surf integration also runs real-engine close/reopen and close-during-boot
checks against the exact packaged image.
