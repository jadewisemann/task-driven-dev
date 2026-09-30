import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Loads node:sqlite while muting its one-time ExperimentalWarning so the CLI
 * output stays clean. Any other warning is passed through untouched.
 */
function loadSqlite() {
  const original = process.emitWarning;
  process.emitWarning = function patched(warning, ...rest) {
    const message = typeof warning === 'string' ? warning : warning?.message;
    if (message && message.includes('SQLite')) return;
    return original.call(process, warning, ...rest);
  };
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

const { DatabaseSync } = loadSqlite();

/** Thin synchronous wrapper around node:sqlite with statement caching, transactions and migrations. */
export class Database {
  /** @param {string} file path or ':memory:' */
  constructor(file) {
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.statements = new Map();
    this.txDepth = 0;
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
  }

  prepare(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  all(sql, params = []) {
    return this.prepare(sql).all(...params);
  }

  get(sql, params = []) {
    return this.prepare(sql).get(...params);
  }

  run(sql, params = []) {
    return this.prepare(sql).run(...params);
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  /**
   * Runs fn inside a transaction. Nested calls join the outer transaction.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  tx(fn) {
    const depth = this.txDepth;
    const savepoint = `sp_${depth}`;
    this.raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.txDepth++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new Error('db.tx() callbacks must be synchronous');
      }
      this.raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      if (depth === 0) this.raw.exec('ROLLBACK');
      else this.raw.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw err;
    } finally {
      this.txDepth = depth;
    }
  }

  /** @param {{id: string, up: string}[]} migrations applied in order, each once (safe across processes) */
  migrate(migrations) {
    this.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of migrations) {
      this.tx(() => {
        // Re-checked inside the write lock so two processes booting together don't both apply it.
        if (this.get('SELECT 1 AS ok FROM schema_migrations WHERE id = ?', [m.id])) return;
        this.exec(m.up);
        this.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [m.id, new Date().toISOString()]);
      });
    }
  }

  close() {
    this.statements.clear();
    this.raw.close();
  }
}

/** Opens a SQLite file read-only (never changes its journal mode or creates -wal files). */
export function openReadOnly(file) {
  return new DatabaseSync(file, { readOnly: true });
}

/** Parses a JSON column, returning fallback for null/invalid content. */
export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Serialises a value for a JSON column (undefined/null -> null). */
export function toJson(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}
