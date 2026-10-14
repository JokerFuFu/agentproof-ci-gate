import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, fsyncSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const emptyState = () => ({ schemaVersion: 1, requests: {}, usedRuns: {} });

export class MemoryStore {
  #state = emptyState();
  load() { return structuredClone(this.#state); }
  save(state) { this.#state = structuredClone(state); }
  close() {}
}
export class FileStore {
  #directory; #path; #lock; #closed = false;
  constructor(directory) {
    this.#directory = directory; this.#path = join(directory, 'state.json'); this.#lock = join(directory, 'gate.lock');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let descriptor;
    try { descriptor = openSync(this.#lock, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`State locked at ${this.#lock}. Verify the recorded process has stopped before removing a stale lock.`);
      throw error;
    }
    try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
  }
  load() {
    if (!existsSync(this.#path)) return emptyState();
    // Corrupt state is never silently replaced: that would discard the replay ledger.
    return JSON.parse(readFileSync(this.#path, 'utf8'));
  }
  save(state) {
    if (this.#closed) throw new Error('Store is closed');
    const temp = join(this.#directory, `state-${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(temp, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(state, null, 2)); fsyncSync(descriptor);
      closeSync(descriptor); descriptor = undefined;
      renameSync(temp, this.#path);
      const directory = openSync(this.#directory, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  close() {
    if (!this.#closed) { this.#closed = true; unlinkSync(this.#lock); }
  }
}
