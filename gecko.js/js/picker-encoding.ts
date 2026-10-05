// Upload replies can be large. JSON serialization and UTF-8 encoding run off
// the browser main thread; the Gecko pthread decodes the returned bytes.
export const PICKER_ENCODER_SOURCE = `
self.onmessage = ({data}) => {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    self.postMessage({bytes}, [bytes.buffer]);
  } catch (error) {
    self.postMessage({error: String(error)});
  }
};`;

export function encodePickerReply(value: unknown, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const url = URL.createObjectURL(new Blob([PICKER_ENCODER_SOURCE], { type: 'text/javascript' }));
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
      worker.onmessage = ({ data }) => {
        finish();
        if (data.error) reject(new Error(data.error));
        else resolve(data.bytes);
      };
      worker.onerror = event => { finish(); reject(new Error(event.message)); };
      signal.addEventListener('abort', abort, { once: true });
      worker.postMessage(value);
    } catch (error) { finish(); reject(error); }
  });
}
