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
    if (this.txDepth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.txDepth--;
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /** @param {{id: string, up: string}[]} migrations applied in order, each once */
  migrate(migrations) {
    this.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all('SELECT id FROM schema_migrations').map((r) => r.id));
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      this.tx(() => {
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
