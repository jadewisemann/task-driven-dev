/**
 * Tiny DOM helpers — no framework.
 *   h('div', { class: 'x', onClick: fn }, 'text', child)
 */
export function h(tag, props = {}, ...children) {
  const isSvg = ['svg', 'path', 'g', 'circle', 'rect', 'line', 'text', 'marker', 'defs', 'polygon'].includes(tag);
  const el = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' && 'value' in el && !isSvg) el.value = value;
    else if (key === 'checked' || key === 'selected' || key === 'disabled') el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Replaces all children of `el`. */
export function mountInto(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export function toast(message, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts' });
    document.body.append(box);
  }
  const item = h('div', { class: `toast toast-${kind}` }, message);
  box.append(item);
  setTimeout(() => item.classList.add('out'), 3500);
  setTimeout(() => item.remove(), 4000);
}

/** Right-side panel. Returns { close, body }. Only one drawer at a time. */
export function openDrawer(title, content, { width = 480, onClose } = {}) {
  document.querySelector('.drawer-backdrop')?.dispatchEvent(new Event('close'));
  const body = h('div', { class: 'drawer-body' }, content);
  const drawer = h('aside', { class: 'drawer', style: { width: `${width}px` } }, h('header', { class: 'drawer-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', title: 'Close', onClick: () => close() }, '✕')), body);
  const backdrop = h('div', { class: 'drawer-backdrop', onClick: (e) => e.target === backdrop && close() }, drawer);
  const onKey = (e) => e.key === 'Escape' && close();
  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  backdrop.addEventListener('close', close);
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  return { close, body };
}

/** Centered modal form. `fields`: [{name, label, type?, value?, options?, placeholder?}] resolves to values or null. */
export function promptForm(title, fields, { submitLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    const inputs = {};
    const form = h(
      'form',
      {
        class: 'modal',
        onSubmit: (e) => {
          e.preventDefault();
          const values = {};
          for (const [name, input] of Object.entries(inputs)) values[name] = input.type === 'checkbox' ? input.checked : input.value;
          done(values);
        },
      },
      h('h3', {}, title),
      fields.map((f) => {
        let input;
        if (f.type === 'textarea') input = h('textarea', { name: f.name, rows: f.rows || 4, placeholder: f.placeholder || '' }, f.value || '');
        else if (f.type === 'select') input = h('select', { name: f.name }, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
        else input = h('input', { name: f.name, type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', checked: f.type === 'checkbox' && f.value });
        inputs[f.name] = input;
        return h('label', { class: 'field' }, h('span', {}, f.label), input);
      }),
      h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn ghost', onClick: () => done(null) }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, submitLabel)),
    );
    const backdrop = h('div', { class: 'modal-backdrop', onClick: (e) => e.target === backdrop && done(null) }, form);
    function done(value) {
      backdrop.remove();
      resolve(value);
    }
    document.body.append(backdrop);
    form.querySelector('input,textarea,select')?.focus();
  });
}

export function confirmDialog(message) {
  return promptForm(message, [], { submitLabel: 'Confirm' }).then((v) => v !== null);
}

export function debounce(fn, ms = 120) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const shortId = (id) => (id ? id.split('_')[1]?.slice(0, 5) || id : '');

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
