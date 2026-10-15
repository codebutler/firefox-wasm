/** A picker selection keeps Blobs in the host until Gecko requests each chunk. */
export interface PickerStream {
  readonly metadata: Record<string, unknown>;
  readonly blobs: readonly Blob[];
}

interface PickerFile {
  readonly name?: string;
  readonly path?: string;
  readonly type?: string;
  readonly lastModified?: number;
  readonly blob: Blob;
}

function describe(files: readonly PickerFile[], blobs: Blob[]): Record<string, unknown>[] {
  return files.map((file) => {
    if (!(file.blob instanceof Blob)) throw new TypeError('Picker file is not a Blob');
    const index = blobs.push(file.blob) - 1;
    return {
      ...(file.name === undefined ? {} : { name: file.name }),
      ...(file.path === undefined ? {} : { path: file.path }),
      ...(file.type === undefined ? {} : { type: file.type }),
      ...(file.lastModified === undefined ? {} : { lastModified: file.lastModified }),
      index,
      size: file.blob.size,
    };
  });
}

export function preparePickerStream(value: unknown, id: string): PickerStream | null {
  if (!value || typeof value !== 'object') return null;
  const reply = value as { files?: readonly PickerFile[]; directory?: { name: string; files: readonly PickerFile[] } };
  const blobs: Blob[] = [];
  if (Array.isArray(reply.files)) {
    return { metadata: { session: id, files: describe(reply.files, blobs) }, blobs };
  }
  if (reply.directory && Array.isArray(reply.directory.files)) {
    return { metadata: { session: id, directory: {
      name: reply.directory.name,
      files: describe(reply.directory.files, blobs),
    } }, blobs };
  }
  return null;
}

export const PICKER_CHUNK_SIZE = 64 * 1024;

// This worker receives one transferred chunk. No whole-file base64 or JSON copy
// enters the host UI thread, and each picker read waits for Gecko's next request.
export const PICKER_CHUNK_ENCODER_SOURCE = `
self.onmessage = ({data}) => {
  try {
    const bytes = new Uint8Array(data);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    self.postMessage({base64: btoa(binary)});
  } catch (error) { self.postMessage({error: String(error)}); }
};`;

export async function encodePickerChunk(blob: Blob, offset: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > blob.size)
    throw new RangeError('Invalid picker offset');
  const bytes = await blob.slice(offset, offset + PICKER_CHUNK_SIZE).arrayBuffer();
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([PICKER_CHUNK_ENCODER_SOURCE], { type: 'text/javascript' }));
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
        else resolve(data.base64);
      };
      worker.onerror = event => { finish(); reject(new Error(event.message)); };
      signal.addEventListener('abort', abort, { once: true });
      worker.postMessage(bytes, [bytes]);
    } catch (error) { finish(); reject(error); }
  });
}
