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

/**
 * Chooses the cheapest capable agent for each planned task:
 *   - a name suggested by the orchestrator model wins when it exists and is capable;
 *   - otherwise score = role fit + tier fit (the smallest tier ≥ required is best,
 *     under-powered agents are heavily penalised) + light load balancing.
 * Orchestrator-role agents are never assigned implementation work.
 *
 * @returns {object[]} tasks with {agentId, agentName, assignReason}
 */
export function assignAgents(tasks, agents) {
  const pool = agents.filter((a) => a.role !== 'orchestrator');
  const load = new Map(pool.map((a) => [a.id, 0]));
  return tasks.map((task) => {
    const need = requiredTier(task.complexity);
    const suggested = task.agent && pool.find((a) => a.name.toLowerCase() === task.agent.toLowerCase());
    if (suggested && suggested.tier >= need) {
      load.set(suggested.id, load.get(suggested.id) + 1);
      return { ...task, agentId: suggested.id, agentName: suggested.name, assignReason: `suggested by orchestrator (tier ${suggested.tier} ≥ ${need})` };
    }
    let best = null;
    for (const a of pool) {
      const roleScore = a.role === task.role ? 10 : ROLE_FAMILY[task.role]?.includes(a.role) ? 5 : a.role === 'generalist' ? 3 : 0;
      const tierScore = a.tier >= need ? -(a.tier - need) * 3 : -(need - a.tier) * 9;
      const score = roleScore + tierScore - load.get(a.id) * 0.5;
      if (!best || score > best.score) best = { agent: a, score, roleScore };
    }
    if (!best) return { ...task, agentId: null, agentName: null, assignReason: 'no agents available' };
    if (best.agent.tier < need) {
      // Nobody on the team is strong enough: borrow the orchestrator rather than under-power a hard task.
      const lead = agents.filter((a) => a.role === 'orchestrator' && a.tier >= need).sort((a, b) => a.tier - b.tier)[0];
      if (lead) return { ...task, agentId: lead.id, agentName: lead.name, assignReason: `no teammate reaches tier ${need}; assigned the orchestrator` };
    }
    load.set(best.agent.id, load.get(best.agent.id) + 1);
    const why = [
      best.roleScore >= 10 ? `role ${task.role}` : best.roleScore > 0 ? `close role (${best.agent.role})` : 'no role match',
      best.agent.tier >= need ? `cheapest capable tier ${best.agent.tier} for complexity ${task.complexity}` : `under-powered: tier ${best.agent.tier} < needed ${need}`,
      suggested ? `(suggested ${suggested.name} is tier ${suggested.tier}, too small)` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return { ...task, agentId: best.agent.id, agentName: best.agent.name, assignReason: why };
  });
}
