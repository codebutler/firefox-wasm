/** A picker selection keeps Blobs in the host until Gecko requests each chunk. */
export interface PickerStream {
  readonly metadata: Record<string, unknown>;
  readonly sources: readonly PickerReadSource[];
}

export interface PickerRangeReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
export type PickerReadSource = Blob | PickerRangeReader;

interface PickerFile {
  readonly name?: string;
  readonly path?: string;
  readonly type?: string;
  readonly lastModified?: number;
  readonly source: PickerReadSource;
}

function describe(files: readonly PickerFile[], sources: PickerReadSource[]): Record<string, unknown>[] {
  return files.map((file) => {
    const source = file.source;
    if (!(source instanceof Blob) &&
        (!source || !Number.isSafeInteger(source.size) || source.size < 0 ||
         typeof source.read !== 'function' || typeof source.close !== 'function'))
      throw new TypeError('Picker file is not a readable source');
    const index = sources.push(source) - 1;
    return {
      ...(file.name === undefined ? {} : { name: file.name }),
      ...(file.path === undefined ? {} : { path: file.path }),
      ...(file.type === undefined ? {} : { type: file.type }),
      ...(file.lastModified === undefined ? {} : { lastModified: file.lastModified }),
      index,
      size: source.size,
    };
  });
}

export function preparePickerStream(value: unknown, id: string): PickerStream | null {
  if (!value || typeof value !== 'object') return null;
  const reply = value as { files?: readonly PickerFile[]; directory?: { name: string; files: readonly PickerFile[] } };
  const sources: PickerReadSource[] = [];
  if (Array.isArray(reply.files)) {
    return { metadata: { session: id, files: describe(reply.files, sources) }, sources };
  }
  if (reply.directory && Array.isArray(reply.directory.files)) {
    return { metadata: { session: id, directory: {
      name: reply.directory.name,
      files: describe(reply.directory.files, sources),
    } }, sources };
  }
  return null;
}

export const PICKER_CHUNK_SIZE = 64 * 1024;

// A picker owns one worker for its lifetime. Structured-cloned Blobs are
// immutable references; the worker reads, encodes, and serializes one chunk at
// a time. No full-payload or raw-byte copy runs on the browser UI thread.
export const PICKER_CHUNK_ENCODER_SOURCE = `
self.onmessage = async ({data}) => {
  if (data.kind === 'init') { self.blobs = data.blobs; return; }
  try {
    let bytes;
    if (data.kind === 'read') {
      const blob = self.blobs[data.index];
      if (!(blob instanceof Blob)) throw new Error('Picker file is unavailable');
      bytes = new Uint8Array(await blob.slice(data.offset, data.offset + 65536).arrayBuffer());
    } else if (data.kind === 'encode') bytes = new Uint8Array(data.bytes);
    else throw new Error('Invalid picker chunk operation');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    const reply = new TextEncoder().encode(JSON.stringify({data: btoa(binary)}));
    self.postMessage({bytes: reply}, [reply.buffer]);
  } catch (error) { self.postMessage({error: String(error)}); }
};`;

export class PickerChunkEncoder {
  private readonly worker: Worker;
  private readonly url: string;
  private readonly signal: AbortSignal;
  private readonly sources: readonly PickerReadSource[];
  private pending: { resolve(bytes: Uint8Array): void; reject(error: unknown): void } | null = null;
  private closed = false;

  constructor(sources: readonly PickerReadSource[], signal: AbortSignal) {
    signal.throwIfAborted();
    this.sources = sources;
    this.signal = signal;
    this.url = URL.createObjectURL(new Blob([PICKER_CHUNK_ENCODER_SOURCE], { type: 'text/javascript' }));
    try { this.worker = new Worker(this.url); }
    catch (error) { URL.revokeObjectURL(this.url); throw error; }
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending;
      this.pending = null;
      if (!pending) return;
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.bytes);
    };
    this.worker.onerror = event => {
      this.pending?.reject(new Error(event.message));
      this.pending = null;
      this.close();
    };
    signal.addEventListener('abort', this.abort, { once: true });
    try {
      this.worker.postMessage({ kind: 'init', blobs: sources.map(source =>
        source instanceof Blob ? source : null) });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private abort = () => this.close();

  read(index: number, offset: number): Promise<Uint8Array> {
    this.signal.throwIfAborted();
    if (this.closed) return Promise.reject(new Error('Picker stream closed'));
    if (this.pending) return Promise.reject(new Error('Picker stream is busy'));
    const source = this.sources[index];
    if (!source || !Number.isSafeInteger(index) || index < 0 ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > source.size)
      return Promise.reject(new RangeError('Invalid picker chunk request'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      if (source instanceof Blob) {
        try { this.worker.postMessage({ kind: 'read', index, offset }); }
        catch (error) { this.pending = null; reject(error); }
      } else {
        void Promise.resolve().then(() => source.read(offset, PICKER_CHUNK_SIZE)).then(bytes => {
          if (this.closed) return;
          if (!(bytes instanceof Uint8Array) || bytes.byteLength > PICKER_CHUNK_SIZE ||
              offset + bytes.byteLength > source.size)
            throw new Error('Invalid picker source chunk');
          const transfer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes : bytes.slice();
          this.worker.postMessage({ kind: 'encode', bytes: transfer }, [transfer.buffer]);
        }).catch(error => {
          if (this.pending) { this.pending.reject(error); this.pending = null; }
        });
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener('abort', this.abort);
    this.worker.terminate();
    URL.revokeObjectURL(this.url);
    for (const source of this.sources) {
      if (!(source instanceof Blob)) void source.close().catch(() => {});
    }
    this.pending?.reject(this.signal.reason ?? new Error('Picker stream closed'));
    this.pending = null;
  }
}
