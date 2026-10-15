import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, resolve, sep } from "path";

/**
 * Where stored files live, addressed by a key relative to the store's root
 * (`records/2026/03/<uuid>_receipt.pdf`). The key is what the database keeps.
 *
 * Local disk is the only backend, and the right one for a single-node SQLite
 * install that also ships as a desktop app. The interface is async so that an
 * object-store driver (S3, R2, Garage) could be added later without changing
 * the callers, but nothing more than that is promised yet: the import pipeline,
 * the text extraction and the ledger upgrade still read and move files on disk
 * directly.
 */
export interface BlobStore {
  put(key: string, data: Uint8Array): Promise<void>;
  /** Size and change time, or null when nothing is stored under the key. */
  stat(key: string): Promise<{ size: number; modifiedMs: number } | null>;
  /** The first `length` bytes, to tell what the file is by its content. */
  head(key: string, length: number): Promise<Uint8Array | null>;
  /** The stored bytes as a stream, so a large file is never held in memory. */
  stream(key: string): ReadableStream<Uint8Array>;
  /** Removes the file. Does nothing when it is already gone. */
  delete(key: string): Promise<void>;
}

export class LocalBlobStore implements BlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * The absolute path for a key. Throws when the key would resolve outside the
   * root (`../`, an absolute path), so no caller can write or read past it.
   */
  pathOf(key: string): string {
    const absolute = resolve(this.root, key);
    if (!absolute.startsWith(this.root + sep)) {
      throw new Error("Storage key escapes the storage root");
    }
    return absolute;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const absolute = this.pathOf(key);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, data);
  }

  async stat(key: string) {
    try {
      const stats = statSync(this.pathOf(key));
      return stats.isFile()
        ? { size: stats.size, modifiedMs: stats.mtimeMs }
        : null;
    } catch {
      return null;
    }
  }

  async head(key: string, length: number): Promise<Uint8Array | null> {
    let fd: number;
    try {
      fd = openSync(this.pathOf(key), "r");
    } catch {
      return null;
    }
    try {
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, 0);
      return buffer.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  }

  stream(key: string): ReadableStream<Uint8Array> {
    return Bun.file(this.pathOf(key)).stream();
  }

  async delete(key: string): Promise<void> {
    try {
      unlinkSync(this.pathOf(key));
    } catch {
      // already gone
    }
  }
}
