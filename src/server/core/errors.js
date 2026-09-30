/** JSON-RPC compatible error codes. */
export const ErrorCode = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  NOT_FOUND: -32004,
  CONFLICT: -32009,
  UNAVAILABLE: -32010,
});

export class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   * @param {unknown} [data]
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }

  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.data !== undefined) out.data = this.data;
    return out;
  }
}

export const invalidParams = (message, data) => new RpcError(ErrorCode.INVALID_PARAMS, message, data);
export const notFound = (what, id) => new RpcError(ErrorCode.NOT_FOUND, `${what} not found: ${id}`);
export const conflict = (message, data) => new RpcError(ErrorCode.CONFLICT, message, data);

/** Normalises any thrown value into an RpcError. */
export function toRpcError(err) {
  if (err instanceof RpcError) return err;
  if (err && typeof err === 'object' && typeof err.code === 'number' && typeof err.message === 'string') {
    return new RpcError(err.code, err.message, err.data);
  }
  return new RpcError(ErrorCode.INTERNAL, err instanceof Error ? err.message : String(err));
}

/** Small param validation helpers used by RPC handlers. */
export const check = {
  object(params) {
    if (params === undefined || params === null) return {};
    if (typeof params !== 'object' || Array.isArray(params)) throw invalidParams('params must be an object');
    return params;
  },
  string(params, key, { optional = false, allowEmpty = false } = {}) {
    const value = params[key];
    if (value === undefined || value === null) {
      if (optional) return undefined;
      throw invalidParams(`"${key}" is required`);
    }
    if (typeof value !== 'string') throw invalidParams(`"${key}" must be a string`);
    if (!allowEmpty && value.trim() === '') throw invalidParams(`"${key}" must not be empty`);
    return value;
  },
  number(params, key, { optional = false, min = -Infinity, max = Infinity, integer = false } = {}) {
    const value = params[key];
    if (value === undefined || value === null) {
      if (optional) return undefined;
      throw invalidParams(`"${key}" is required`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidParams(`"${key}" must be a finite number`);
    if (integer && !Number.isInteger(value)) throw invalidParams(`"${key}" must be an integer`);
    if (value < min || value > max) throw invalidParams(`"${key}" must be between ${min} and ${max}`);
    return value;
  },
  oneOf(params, key, values, { optional = false } = {}) {
    const value = params[key];
    if (value === undefined || value === null) {
      if (optional) return undefined;
      throw invalidParams(`"${key}" is required`);
    }
    if (!values.includes(value)) throw invalidParams(`"${key}" must be one of: ${values.join(', ')}`);
    return value;
  },
  stringArray(params, key, { optional = false } = {}) {
    const value = params[key];
    if (value === undefined || value === null) {
      if (optional) return undefined;
      throw invalidParams(`"${key}" is required`);
    }
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw invalidParams(`"${key}" must be an array of strings`);
    }
    return value;
  },
};
