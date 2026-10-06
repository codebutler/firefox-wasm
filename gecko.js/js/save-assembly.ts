// Transfer owned chunks to a worker: constructing a large Blob must not stall
// the embedding desktop. Only the completed, immutable Blob returns to it.
export const SAVE_ASSEMBLER_SOURCE = `
self.onmessage = ({data}) => {
  try { self.postMessage({blob: new Blob(data.chunks, {type: data.type})}); }
  catch (error) { self.postMessage({error: String(error)}); }
};`;

export function assembleSave(chunks: Uint8Array<ArrayBuffer>[], type: string, signal: AbortSignal): Promise<Blob> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const url = URL.createObjectURL(new Blob([SAVE_ASSEMBLER_SOURCE], { type: 'text/javascript' }));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    const finish = () => {
      worker?.terminate();
      URL.revokeObjectURL(url);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => { finish(); reject(signal.reason); };
    try {
      worker = new Worker(url);
      worker.onmessage = ({data}) => {
        finish();
        if (data.error) reject(new Error(data.error));
        else resolve(data.blob);
      };
      worker.onerror = event => { finish(); reject(new Error(event.message)); };
      signal.addEventListener('abort', abort, { once: true });
      worker.postMessage({chunks, type}, chunks.map(chunk => chunk.buffer));
    } catch (error) { finish(); reject(error); }
  });
}
