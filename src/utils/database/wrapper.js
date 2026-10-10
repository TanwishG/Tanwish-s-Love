import { pgDb } from '../postgresDatabase.js';
import path from 'node:path';
import { MemoryStorage } from '../memoryStorage.js';
import { FileStorage } from '../fileStorage.js';
import { logger } from '../logger.js';
import { validateGuildConfigOrThrow } from '../schemas.js';

function hasPostgresConfig() {
    return Boolean(process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_HOST);
}

class DatabaseWrapper {
    constructor() {
        this.initialized = false;
        this.db = null;
        this.useFallback = false;
        this.connectionType = 'none';
        this.degradedModeWarningShown = false;
        this.degradedReason = null;
        this.persistent = false;
    }

    async initialize() {
        if (this.initialized) {
            return;
        }

        const postgresConfigured = hasPostgresConfig();

        try {
            if (!postgresConfigured) {
                throw new Error('No PostgreSQL settings found (POSTGRES_URL / DATABASE_URL / POSTGRES_HOST)');
            }
            logger.info('Attempting to connect to PostgreSQL...');
            const pgConnected = await pgDb.connect();
            if (pgConnected) {
                this.db = pgDb;
                this.connectionType = 'postgresql';
                this.degradedReason = null;
                logger.info('✅ PostgreSQL Database initialized - using persistent database');
                this.initialized = true;
                return;
            }

            const pgFailure = pgDb.getLastFailure?.();
            if (pgFailure?.reason === 'SCHEMA_VERSION_MISMATCH') {
                const schemaError = new Error(
                    `Schema version mismatch detected (${pgFailure.message}). Run migrations before startup.`,
                );
                schemaError.code = 'SCHEMA_VERSION_MISMATCH';
                throw schemaError;
            }
        } catch (error) {
            if (postgresConfigured) {
                logger.warn('PostgreSQL connection failed:', error.message);
            } else {
                logger.info(`${error.message}; using file storage instead.`);
            }

            if (error.code === 'SCHEMA_VERSION_MISMATCH') {
                throw error;
            }
        }

        // No PostgreSQL: keep data in a JSON file so settings survive restarts.
        // Set DATABASE_MODE=memory to opt out (data is then lost on restart).
        if ((process.env.DATABASE_MODE || 'file').toLowerCase() !== 'memory') {
            try {
                const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
                const fileDb = new FileStorage(path.join(dataDir, 'bot-data.json'));
                fileDb.load();

                this.db = fileDb;
                this.useFallback = true;
                this.persistent = true;
                this.connectionType = 'file';
                this.degradedReason = postgresConfigured ? 'POSTGRES_UNAVAILABLE' : 'POSTGRES_NOT_CONFIGURED';
                logger.info(`✅ File storage active - data is saved to ${path.join(dataDir, 'bot-data.json')}`);
                this.initialized = true;
                return;
            } catch (error) {
                logger.warn(`File storage could not start (${error.message}); falling back to memory.`);
            }
        }

        this.db = new MemoryStorage();
        this.useFallback = true;
        this.connectionType = 'memory';
        this.degradedReason = 'POSTGRES_UNAVAILABLE';
        logger.warn('⚠️ DATABASE DEGRADED MODE ENABLED - Using in-memory storage (data will be lost on restart)');
        logger.warn('⚠️ Please check PostgreSQL connection and restart the bot when fixed');
        this.initialized = true;
        this.degradedModeWarningShown = true;
    }

    async set(key, value, ttl = null) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Writing to memory: ${key}`);
        }

        if (typeof key === 'string' && /^guild:[^:]+:config$/.test(key)) {
            const guildId = key.split(':')[1];
            validateGuildConfigOrThrow(value, {
                guildId,
                errorCode: 'VALIDATION_FAILED',
            });
        }

        return this.db.set(key, value, ttl);
    }

    async get(key, defaultValue = null) {
        return this.db.get(key, defaultValue);
    }

    async delete(key) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Deleting from memory: ${key}`);
        }
        return this.db.delete(key);
    }

    async list(prefix) {
        return this.db.list(prefix);
    }

    async exists(key) {
        if (this.db.exists) {
            return this.db.exists(key);
        }
        const value = await this.db.get(key);
        return value !== null;
    }

    async increment(key, amount = 1) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Incrementing in memory: ${key}`);
        }
        if (this.db.increment) {
            return this.db.increment(key, amount);
        }
        const current = await this.db.get(key, 0);
        const newValue = current + amount;
        await this.db.set(key, newValue);
        return newValue;
    }

    async decrement(key, amount = 1) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Decrementing in memory: ${key}`);
        }
        if (this.db.decrement) {
            return this.db.decrement(key, amount);
        }
        const current = await this.db.get(key, 0);
        const newValue = current - amount;
        await this.db.set(key, newValue);
        return newValue;
    }

    isDegraded() {
        return this.useFallback && !this.persistent;
    }

    /** True when data survives a restart without PostgreSQL (file storage). */
    isPersistent() {
        return this.persistent;
    }

    /** Reads are trustworthy on PostgreSQL and on file storage, but not on plain memory fallback. */
    canServeReads() {
        return Boolean(this.db) && (this.isAvailable() || this.persistent);
    }

    async flush() {
        if (typeof this.db?.flush === 'function') {
            await this.db.flush();
        }
    }

    isAvailable() {
        return this.db && !this.useFallback;
    }

    getStatus() {
        return {
            initialized: this.initialized,
            connectionType: this.connectionType,
            isDegraded: this.isDegraded(),
            isPersistent: this.persistent,
            isAvailable: this.isAvailable(),
            degradedReason: this.degradedReason,
        };
    }

    getConnectionType() {
        return this.connectionType;
    }
}

export const db = new DatabaseWrapper();

export async function initializeDatabase() {
    try {
        logger.info('Initializing Database (PostgreSQL > file storage > memory)...');
        await db.initialize();
        logger.info('✅ Database initialized');
        return { db };
    } catch (error) {
        logger.error('❌ Database Initialization Error:', error);

        if (error.code === 'SCHEMA_VERSION_MISMATCH') {
            throw error;
        }

        return { db };
    }
}

export async function getFromDb(key, defaultValue = null) {
    try {
        const value = await db.get(key);
        return value === null ? defaultValue : value;
    } catch (error) {
        logger.error(`Error getting value for key ${key}:`, error);
        return defaultValue;
    }
}

export async function setInDb(key, value, ttl = null) {
    try {
        await db.set(key, value, ttl);
        return true;
    } catch (error) {
        logger.error(`Error setting value for key ${key}:`, error);
        return false;
    }
}

export async function deleteFromDb(key) {
    try {
        await db.delete(key);
        return true;
    } catch (error) {
        logger.error(`Error deleting key ${key}:`, error);
        return false;
    }
}
