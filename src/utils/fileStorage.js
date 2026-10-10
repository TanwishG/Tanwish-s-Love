// fileStorage.js
//
// Persistent key-value storage backed by a single JSON file. Used automatically when no
// PostgreSQL database is configured (for example on hosts that only give you a file system).
//
// It behaves like the PostgreSQL layer from the caller's point of view: values are
// JSON-normalised on the way in and copied on the way out, so mutating an object you
// received never silently changes what is stored.

import fs from 'node:fs';
import path from 'node:path';
import { MemoryStorage } from './memoryStorage.js';
import { logger } from './logger.js';

const SAVE_DEBOUNCE_MS = 2_000;
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const FILE_VERSION = 1;

function toStorable(value) {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
}

export class FileStorage extends MemoryStorage {
    constructor(filePath) {
        super();
        this.filePath = filePath;
        this.dirty = false;
        this.saveTimer = null;
        this.writeChain = Promise.resolve();
        this.lastBackupAt = 0;
        this.exitHookInstalled = false;
    }

    /** Read the file (if any) into memory. Never throws; a damaged file is set aside. */
    load() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

        if (fs.existsSync(this.filePath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : {};
                const expires = parsed?.expires && typeof parsed.expires === 'object' ? parsed.expires : {};
                const now = Date.now();

                for (const [key, value] of Object.entries(data)) {
                    const expiresAt = expires[key];
                    if (typeof expiresAt === 'number' && expiresAt <= now) continue;
                    this.data.set(key, value);
                    if (typeof expiresAt === 'number') this.expirationTimes.set(key, expiresAt);
                }
                logger.info(`💾 Loaded ${this.data.size} stored entries from ${this.filePath}`);
            } catch (error) {
                const damaged = `${this.filePath}.corrupt-${Date.now()}`;
                try {
                    fs.renameSync(this.filePath, damaged);
                } catch {
                    // ignore
                }
                logger.error(`Data file could not be read (${error.message}). Moved to ${damaged}; starting empty.`);
            }
        } else {
            logger.info(`💾 No data file yet; a new one will be created at ${this.filePath}`);
        }

        if (!this.exitHookInstalled) {
            this.exitHookInstalled = true;
            process.on('exit', () => this.flushSync());
        }
    }

    async get(key, defaultValue = null) {
        const value = await super.get(key, undefined);
        return value === undefined ? defaultValue : structuredClone(value);
    }

    async set(key, value, ttl = null) {
        await super.set(key, toStorable(value), ttl);
        this.markDirty();
        return true;
    }

    async delete(key) {
        await super.delete(key);
        this.markDirty();
        return true;
    }

    async clear() {
        await super.clear();
        this.markDirty();
        return true;
    }

    markDirty() {
        this.dirty = true;
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.flush();
        }, SAVE_DEBOUNCE_MS);
        this.saveTimer.unref?.();
    }

    serialize() {
        return JSON.stringify({
            version: FILE_VERSION,
            savedAt: new Date().toISOString(),
            data: Object.fromEntries(this.data),
            expires: Object.fromEntries(this.expirationTimes),
        });
    }

    /** Write pending changes to disk (atomic: temp file, then rename). */
    flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (!this.dirty) return this.writeChain;

        this.dirty = false;
        const payload = this.serialize();

        this.writeChain = this.writeChain
            .then(async () => {
                const tmp = `${this.filePath}.tmp`;
                if (Date.now() - this.lastBackupAt > BACKUP_INTERVAL_MS) {
                    await fs.promises.copyFile(this.filePath, `${this.filePath}.bak`).catch(() => {});
                    this.lastBackupAt = Date.now();
                }
                await fs.promises.writeFile(tmp, payload);
                await fs.promises.rename(tmp, this.filePath);
            })
            .catch((error) => {
                this.dirty = true;
                logger.error(`Could not save data file: ${error.message}`);
            });

        return this.writeChain;
    }

    /** Synchronous save, used when the process is exiting. */
    flushSync() {
        if (!this.dirty) return;
        try {
            fs.writeFileSync(`${this.filePath}.tmp`, this.serialize());
            fs.renameSync(`${this.filePath}.tmp`, this.filePath);
            this.dirty = false;
        } catch (error) {
            logger.error(`Could not save data file on exit: ${error.message}`);
        }
    }
}
