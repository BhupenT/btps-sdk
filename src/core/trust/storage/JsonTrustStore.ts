/**
 * @license
 * Copyright (c) 2025 Bhupendra Tamang
 * Licensed under the Apache License, Version 2.0
 * https://www.apache.org/licenses/LICENSE-2.0
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import { lock } from 'proper-lockfile';
import debounce from 'lodash/debounce.js';
import isEmpty from 'lodash/isEmpty.js';

import { AbstractTrustStore } from './AbstractTrustStore.js';
import { BTPTrustRecord, TrustStoreOptions } from '../types.js';
import { computeTrustId } from '../index.js';

/**
 * JSON-based TrustStore for self-hosted environments.
 * Uses a Map internally for fast lookup and persists trust records to a single JSON file.
 * Supports multi-tenant BTPS inboxes by indexing records by to Identity + from Identity.
 */
class JsonTrustStore extends AbstractTrustStore<BTPTrustRecord> {
  private recordMap: Map<string, BTPTrustRecord> = new Map();
  private dirty = false;
  private filePath: string;
  private hasEntity: boolean = false;
  private writeDebounced: () => void;
  private lastChangedMtime: number = 0;

  constructor(options: TrustStoreOptions) {
    super(options);

    if (typeof options.connection !== 'string') {
      throw new Error('JSON TrustStore expects a file path as connection');
    }

    this.filePath = options.connection;
    this.hasEntity = !isEmpty(this.entityName);

    this.writeDebounced = debounce(() => this.writeToFile(), 1000);

    // Flush pending writes on process shutdown
    process.on('SIGINT', async () => {
      await this.writeToFile();
      process.exit();
    });
    process.on('SIGTERM', async () => {
      await this.writeToFile();
      process.exit();
    });
  }

  /**
   * checks and reloads if the file has changed externally or manually
   */
  private async reloadIfChanged(): Promise<void> {
    const stat = await fs.stat(this.filePath);
    const mtime = stat.mtimeMs;

    if (mtime !== this.lastChangedMtime) {
      await this.flushAndReload();
      this.lastChangedMtime = mtime;
    }
  }

  /**
   * Initializes in-memory store from disk. If file is missing, creates a new one.
   */
  private async init(): Promise<void> {
    if (!existsSync(this.filePath)) {
      const empty = this.hasEntity ? { [this.entityName as string]: [] } : [];
      await fs.writeFile(this.filePath, JSON.stringify(empty, null, 2), 'utf8');
    }

    const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    const records: BTPTrustRecord[] = this.hasEntity ? raw?.[this.entityName as string] || [] : raw;

    this.recordMap.clear();
    for (const r of records) {
      const key = r.id;
      this.recordMap.set(key, r);
    }
  }

  /**
   * Atomically writes the in-memory trust records to disk using a lock.
   */
  private async writeToFile() {
    if (!this.dirty) return;
    this.dirty = false;

    let release: (() => Promise<void>) | undefined;
    const tmpPath = this.filePath + '.tmp';

    try {
      release = await lock(this.filePath, {
        retries: { retries: 5, factor: 1.5, minTimeout: 100, maxTimeout: 1000 },
        stale: 5000,
      });

      const records = [...this.recordMap.values()];
      const contents = this.hasEntity ? { [this.entityName as string]: records } : records;

      await fs.writeFile(tmpPath, JSON.stringify(contents, null, 2), 'utf8');
      await fs.rename(tmpPath, this.filePath); // Atomic replace
      /* update the file changed time so updated from the class will match on read avoiding double flush */
      this.lastChangedMtime = (await fs.stat(this.filePath)).mtimeMs;
    } finally {
      if (release) await release();
    }
  }

  /**
   * Retrieves a trust record for a specific to/from pair.
   */
  async getById(computedId: string): Promise<BTPTrustRecord | undefined> {
    if (this.recordMap.size === 0) await this.init();
    await this.reloadIfChanged();
    return this.recordMap.get(computedId);
  }

  /**
   * Creates a new trust record. Fails if one already exists for to/from.
   */
  async create(record: Omit<BTPTrustRecord, 'id'>, computedId?: string): Promise<BTPTrustRecord> {
    if ('id' in record) {
      throw new Error('Record passed to create() must not include an id');
    }

    const id = computedId ?? computeTrustId(record.senderId, record.receiverId);
    if (await this.getById(id)) {
      throw new Error(`Trust record already exists for ${record.senderId} → ${record.receiverId}`);
    }

    const newRecord = { id, ...record };

    this.recordMap.set(id, newRecord);
    this.dirty = true;
    this.writeDebounced();
    return newRecord;
  }

  /**
   * Updates an existing trust record by merging with the patch.
   */
  async update(computedId: string, patch: Partial<BTPTrustRecord>): Promise<BTPTrustRecord> {
    const record = await this.getById(computedId);
    if (!record)
      throw new Error(`No trust record found for ${patch.senderId} → ${patch.receiverId}`);

    const updated = { ...record, ...patch };
    this.recordMap.set(computedId, updated);
    this.dirty = true;
    this.writeDebounced();
    return updated;
  }

  /**
   * Deletes a trust record for a given to/from pair.
   */
  async delete(computedId: string): Promise<void> {
    if (this.recordMap.size === 0) await this.init();
    if (this.recordMap.delete(computedId)) {
      this.dirty = true;
      this.writeDebounced();
    }
  }

  /**
   * Returns all trust records, optionally filtered by to.
   */
  async getAll(receiverId?: string): Promise<BTPTrustRecord[]> {
    if (this.recordMap.size === 0) await this.init();
    await this.reloadIfChanged();
    const all = [...this.recordMap.values()];
    return receiverId ? all.filter((r) => r.receiverId === receiverId) : all;
  }

  /**
   * Forces immediate disk flush of trust records.
   */
  async flushNow(): Promise<void> {
    await this.writeToFile();
  }

  /**
   * Flushes and reloads trust records from disk.
   */
  async flushAndReload(): Promise<void> {
    await this.writeToFile();
    this.recordMap.clear();
    await this.init();
  }
}

export default JsonTrustStore;
