/**
 * Tiny, safe expression layer for workflow nodes (no eval):
 *   - paths:      input.json.status   nodes.review.json.items[0].id   vars.task.title
 *   - templates:  "Fix {{input.json.feedback}}"  — a string that is exactly one
 *                 {{path}} returns the raw value (object/number), otherwise text.
 *   - conditions: { path, op, value } evaluated against a scope.
 */

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Resolves a dotted/bracketed path ("a.b[0].c") against an object. Missing -> undefined. */
export function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[["']([^"']+)["']\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') return undefined;
    cur = Object.hasOwn(Object(cur), p) || (Array.isArray(cur) && p === 'length') ? cur[p] : undefined;
  }
  return cur;
}

const stringify = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));

/** Renders a template string against scope. */
export function renderTemplate(template, scope) {
  if (typeof template !== 'string') return template;
  const single = template.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (single) return getPath(scope, single[1]);
  return template.replace(TOKEN, (_, path) => stringify(getPath(scope, path)));
}

/** Deep-renders every string inside a JSON-like value. */
export function renderDeep(value, scope) {
  if (typeof value === 'string') return renderTemplate(value, scope);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, scope));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, scope)]));
  return value;
}

const num = (v) => (typeof v === 'number' ? v : Number(v));

const scalar = (v) => v === null || typeof v !== 'object';

export const OPERATORS = {
  // Scalars compare loosely ("3" eq 3); objects/arrays compare structurally.
  eq: (a, b) => a === b || (a !== undefined && b !== undefined && (scalar(a) && scalar(b) ? a !== null && String(a) === String(b) : JSON.stringify(a) === JSON.stringify(b))),
  neq: (a, b) => !OPERATORS.eq(a, b),
  gt: (a, b) => num(a) > num(b),
  gte: (a, b) => num(a) >= num(b),
  lt: (a, b) => num(a) < num(b),
  lte: (a, b) => num(a) <= num(b),
  contains: (a, b) => (Array.isArray(a) ? a.some((x) => OPERATORS.eq(x, b)) : String(a ?? '').includes(String(b ?? ''))),
  notContains: (a, b) => !OPERATORS.contains(a, b),
  in: (a, b) => (Array.isArray(b) ? b : String(b ?? '').split(',').map((s) => s.trim())).some((x) => OPERATORS.eq(a, x)),
  exists: (a) => a !== undefined && a !== null && a !== '',
  notExists: (a) => a === undefined || a === null || a === '',
  truthy: (a) => Boolean(a) && a !== 'false' && a !== '0',
  falsy: (a) => !OPERATORS.truthy(a),
  // Bounded to limit catastrophic backtracking on untrusted (agent) text.
  regex: (a, b) => {
    const pattern = String(b ?? '');
    if (pattern.length > 200) return false;
    try {
      return new RegExp(pattern).test(String(a ?? '').slice(0, 10_000));
    } catch {
      return false;
    }
  },
};

/** Evaluates one {path, op, value} condition. `value` may itself be a template. */
export function evaluateCondition(cond, scope) {
  const op = OPERATORS[cond.op] || OPERATORS.eq;
  const left = getPath(scope, cond.path);
  const right = typeof cond.value === 'string' ? renderTemplate(cond.value, scope) : cond.value;
  return op(left, right);
}

/** Evaluates a rule {conditions: [...], match: 'all'|'any'}; no conditions = always true. */
export function evaluateRule(rule, scope) {
  const conditions = rule.conditions || [];
  if (conditions.length === 0) return true;
  return rule.match === 'any' ? conditions.some((c) => evaluateCondition(c, scope)) : conditions.every((c) => evaluateCondition(c, scope));
}
