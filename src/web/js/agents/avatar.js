import { h } from '../dom.js';

const initials = (name = '?') =>
  name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';

export const TIER_LABEL = { 1: 'small', 2: 'standard', 3: 'frontier' };

/** Round initials avatar in the agent's colour. */
export function avatar(agent, { size = 26, title } = {}) {
  if (!agent) {
    return h('span', { class: 'avatar empty', style: { width: `${size}px`, height: `${size}px` }, title: title || 'Unassigned' }, '?');
  }
  return h(
    'span',
    {
      class: 'avatar',
      style: { width: `${size}px`, height: `${size}px`, background: agent.color, fontSize: `${Math.round(size * 0.42)}px` },
      title: title || `${agent.name} · ${agent.role} · ${agent.harness}/${agent.model || 'default'} · effort ${agent.effort}`,
    },
    initials(agent.name),
  );
}

export function tierBadge(tier) {
  return h('span', { class: `badge tier tier-${tier}`, title: `Model tier ${tier}` }, `T${tier} ${TIER_LABEL[tier] || ''}`);
}
