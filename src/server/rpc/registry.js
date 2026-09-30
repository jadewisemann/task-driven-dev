import { ErrorCode, RpcError, check, toRpcError } from '../core/errors.js';

/**
 * Single API surface shared by HTTP (/api/rpc), the stdio bridge used over SSH
 * and the CLI. Handlers receive validated-object params and a context object.
 */
export class RpcRegistry {
  constructor() {
    /** @type {Map<string, {handler: Function, description: string}>} */
    this.methods = new Map();
  }

  /**
   * @param {string} name namespaced method, e.g. "tasks.create"
   * @param {(params: object, ctx: object) => unknown} handler
   * @param {string} [description]
   */
  register(name, handler, description = '') {
    if (this.methods.has(name)) throw new Error(`RPC method already registered: ${name}`);
    this.methods.set(name, { handler, description });
  }

  /** Registers a group of methods under a namespace prefix. */
  group(prefix, table) {
    for (const [name, def] of Object.entries(table)) {
      const { handler, description } = typeof def === 'function' ? { handler: def, description: '' } : def;
      this.register(`${prefix}.${name}`, handler, description);
    }
  }

  async call(method, params, ctx = {}) {
    const entry = this.methods.get(method);
    if (!entry) throw new RpcError(ErrorCode.METHOD_NOT_FOUND, `Unknown method: ${method}`);
    return entry.handler(check.object(params), ctx);
  }

  /**
   * Executes a JSON-RPC 2.0 request object and returns the response object
   * (or null for notifications).
   */
  async handle(request, ctx = {}) {
    const id = request && Object.hasOwn(request, 'id') ? request.id : undefined;
    try {
      if (!request || typeof request.method !== 'string') {
        throw new RpcError(ErrorCode.INVALID_REQUEST, 'Invalid request');
      }
      const result = await this.call(request.method, request.params, ctx);
      return id === undefined ? null : { jsonrpc: '2.0', id, result: result ?? null };
    } catch (err) {
      const error = toRpcError(err);
      if (error.code === ErrorCode.INTERNAL && ctx.log) ctx.log(err);
      return { jsonrpc: '2.0', id: id ?? null, error: error.toJSON() };
    }
  }

  list() {
    return [...this.methods.entries()].map(([name, { description }]) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name));
  }
}
