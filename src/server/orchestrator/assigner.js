/** Minimum model tier a task needs, from its complexity (1-5). */
export const requiredTier = (complexity) => (complexity >= 4 ? 3 : complexity >= 3 ? 2 : 1);

/** Roles that can reasonably stand in for each other. */
const ROLE_FAMILY = {
  engineer: ['backend', 'frontend', 'generalist', 'devops'],
  backend: ['engineer', 'generalist'],
  frontend: ['engineer', 'designer', 'generalist'],
  qa: ['reviewer', 'engineer', 'generalist'],
  reviewer: ['qa', 'engineer', 'generalist'],
  writer: ['generalist', 'engineer'],
  devops: ['engineer', 'backend', 'generalist'],
  designer: ['frontend', 'generalist'],
  researcher: ['generalist', 'engineer'],
};

const roleScore = (agent, role) => (agent.role === role ? 10 : ROLE_FAMILY[role]?.includes(agent.role) ? 5 : agent.role === 'generalist' ? 3 : 0);

/**
 * Chooses the cheapest capable agent for each planned task.
 *
 *   1. Capable agents (tier ≥ required) are always preferred over under-powered ones;
 *      among them: best role fit, then the smallest tier, then the lightest load.
 *   2. A teammate suggested by the orchestrator model is honoured when it is capable
 *      and not wastefully over-powered (at most one tier above what is needed).
 *   3. Only when no teammate is capable is an orchestrator-role agent borrowed;
 *      failing that, the strongest available agent gets it (flagged as under-powered).
 *
 * @param {object[]} tasks planned tasks ({key, role, complexity, agent?})
 * @param {object[]} agents
 * @param {Map<string, number>} [initialLoad] tasks already given to each agent (e.g. kept assignments)
 */
export function assignAgents(tasks, agents, initialLoad = new Map()) {
  const pool = agents.filter((a) => a.role !== 'orchestrator');
  const leads = agents.filter((a) => a.role === 'orchestrator');
  const load = new Map(agents.map((a) => [a.id, initialLoad.get(a.id) || 0]));
  const give = (task, agent, assignReason) => {
    load.set(agent.id, load.get(agent.id) + 1);
    return { ...task, agentId: agent.id, agentName: agent.name, assignReason };
  };

  return tasks.map((task) => {
    const need = requiredTier(task.complexity);
    const suggested = task.agent && pool.find((a) => a.name.toLowerCase() === task.agent.toLowerCase());
    if (suggested && suggested.tier >= need && suggested.tier <= need + 1) {
      return give(task, suggested, `suggested by orchestrator (tier ${suggested.tier} for complexity ${task.complexity})`);
    }
    const capable = pool.filter((a) => a.tier >= need);
    const note = suggested ? ` (suggested ${suggested.name} is tier ${suggested.tier}: ${suggested.tier < need ? 'too small' : 'over-powered'})` : '';
    if (capable.length) {
      const ranked = capable
        .map((a) => ({ a, score: roleScore(a, task.role) - (a.tier - need) * 4 - load.get(a.id) * 0.5 }))
        .sort((x, y) => y.score - x.score);
      const best = ranked[0].a;
      const fit = roleScore(best, task.role) >= 10 ? `role ${task.role}` : roleScore(best, task.role) > 0 ? `close role (${best.role})` : `no ${task.role} specialist`;
      return give(task, best, `${fit}, cheapest capable tier ${best.tier} for complexity ${task.complexity}${note}`);
    }
    const lead = leads.filter((a) => a.tier >= need).sort((a, b) => a.tier - b.tier)[0];
    if (lead) return give(task, lead, `no teammate reaches tier ${need}; assigned the orchestrator${note}`);
    const strongest = [...pool, ...leads].sort((a, b) => b.tier - a.tier || roleScore(b, task.role) - roleScore(a, task.role))[0];
    if (!strongest) return { ...task, agentId: null, agentName: null, assignReason: 'no agents available' };
    return give(task, strongest, `under-powered: best available is tier ${strongest.tier} < needed ${need}${note}`);
  });
}
