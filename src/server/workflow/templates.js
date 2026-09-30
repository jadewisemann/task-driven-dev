/**
 * Starter graphs. `agents` is used to pick sensible default agents by role.
 * Node ids are stable strings so templates read well in the editor.
 */
export function workflowTemplates(agents = []) {
  const byRole = (role) => agents.find((a) => a.role === role)?.id || agents[0]?.id || 'self';
  const reviewer = byRole('reviewer');
  const engineer = byRole('engineer');

  return [
    {
      key: 'implement-review-loop',
      name: 'Implement → review loop',
      scope: 'agent',
      description: 'The owning agent implements, a reviewer checks the result, and changes are looped back until approved (max 3 rounds).',
      graph: {
        nodes: [
          { id: 'start', type: 'trigger', name: 'Task', x: 40, y: 160, config: { sample: { prompt: 'Add a /health endpoint', system: '' } } },
          {
            id: 'implement',
            type: 'agent',
            name: 'Implement',
            x: 280,
            y: 140,
            config: { agentId: 'self', prompt: '{{vars.prompt}}\n\n{{nodes.review.json.feedback}}', maxVisits: 3 },
          },
          {
            id: 'review',
            type: 'agent',
            name: 'Review',
            x: 560,
            y: 140,
            config: {
              agentId: reviewer,
              prompt:
                'Review this work for the task below.\n\nTask:\n{{vars.task.title}}\n{{vars.task.description}}\n\nImplementer report:\n{{input.text}}\n\nReply with a fenced ```json block: {"status": "approved" | "changes_requested", "feedback": "concrete changes if any"}',
              maxVisits: 3,
            },
          },
          {
            id: 'route',
            type: 'router',
            name: 'Approved?',
            x: 840,
            y: 150,
            config: {
              mode: 'rules',
              rules: [
                { port: 'approved', match: 'all', conditions: [{ path: 'input.json.status', op: 'eq', value: 'approved' }] },
                { port: 'retry', match: 'all', conditions: [{ path: 'visits.review', op: 'lt', value: 3 }] },
              ],
            },
          },
          {
            id: 'done',
            type: 'output',
            name: 'Result',
            x: 1100,
            y: 80,
            config: { text: '{{nodes.implement.text}}', json: { status: 'done', summary: '{{nodes.implement.json.summary}}', review: '{{nodes.review.json}}' } },
          },
          {
            id: 'escalate',
            type: 'output',
            name: 'Needs human',
            x: 1100,
            y: 260,
            config: { text: '{{nodes.implement.text}}', json: { status: 'needs_review', summary: 'Reviewer still requests changes after 3 rounds', review: '{{nodes.review.json}}' } },
          },
        ],
        edges: [
          { id: 'e1', from: 'start', fromPort: 'out', to: 'implement', toPort: 'in' },
          { id: 'e2', from: 'implement', fromPort: 'out', to: 'review', toPort: 'in' },
          { id: 'e3', from: 'review', fromPort: 'out', to: 'route', toPort: 'in' },
          { id: 'e4', from: 'route', fromPort: 'approved', to: 'done', toPort: 'in' },
          { id: 'e5', from: 'route', fromPort: 'retry', to: 'implement', toPort: 'in' },
          { id: 'e6', from: 'route', fromPort: 'else', to: 'escalate', toPort: 'in' },
        ],
      },
    },
    {
      key: 'json-triage',
      name: 'JSON triage router',
      scope: 'project',
      description: 'Routes an incoming JSON item (bug / feature / question) by its fields and turns it into board cards for the right agent.',
      graph: {
        nodes: [
          { id: 'start', type: 'trigger', name: 'Incoming item', x: 40, y: 200, config: { sample: { type: 'bug', severity: 'high', title: 'Login fails on Safari', body: 'Steps: …' } } },
          {
            id: 'route',
            type: 'router',
            name: 'Triage',
            x: 300,
            y: 190,
            config: {
              mode: 'rules',
              rules: [
                {
                  port: 'urgent_bug',
                  match: 'all',
                  conditions: [
                    { path: 'input.type', op: 'eq', value: 'bug' },
                    { path: 'input.severity', op: 'in', value: 'high,critical' },
                  ],
                },
                { port: 'bug', match: 'all', conditions: [{ path: 'input.type', op: 'eq', value: 'bug' }] },
                { port: 'feature', match: 'all', conditions: [{ path: 'input.type', op: 'eq', value: 'feature' }] },
              ],
            },
          },
          { id: 'urgent', type: 'task.create', name: 'Urgent fix card', x: 600, y: 60, config: { title: '[URGENT] {{input.title}}', description: '{{input.body}}', assigneeId: engineer, status: 'todo', priority: 3 } },
          { id: 'bug', type: 'task.create', name: 'Bug card', x: 600, y: 190, config: { title: 'Bug: {{input.title}}', description: '{{input.body}}', assigneeId: engineer, status: 'todo', priority: 1 } },
          { id: 'feature', type: 'task.create', name: 'Feature card', x: 600, y: 320, config: { title: 'Feature: {{input.title}}', description: '{{input.body}}', assigneeId: '', status: 'backlog', priority: 1 } },
          { id: 'other', type: 'output', name: 'Ignored', x: 600, y: 450, config: { text: 'Not actionable: {{input.title}}', json: { status: 'done', routed: 'none' } } },
        ],
        edges: [
          { id: 'e1', from: 'start', fromPort: 'out', to: 'route', toPort: 'in' },
          { id: 'e2', from: 'route', fromPort: 'urgent_bug', to: 'urgent', toPort: 'in' },
          { id: 'e3', from: 'route', fromPort: 'bug', to: 'bug', toPort: 'in' },
          { id: 'e4', from: 'route', fromPort: 'feature', to: 'feature', toPort: 'in' },
          { id: 'e5', from: 'route', fromPort: 'else', to: 'other', toPort: 'in' },
        ],
      },
    },
    {
      key: 'fan-out-merge',
      name: 'Parallel opinions → merge → decide',
      scope: 'project',
      description: 'Two agents answer the same question in parallel, results are merged and an agent-driven router picks the next step.',
      graph: {
        nodes: [
          { id: 'start', type: 'trigger', name: 'Question', x: 40, y: 200, config: { sample: { question: 'Should we use SQLite or Postgres for v1?' } } },
          { id: 'a', type: 'agent', name: 'Engineer view', x: 300, y: 100, config: { agentId: engineer, prompt: 'Answer briefly with trade-offs: {{input.question}}' } },
          { id: 'b', type: 'agent', name: 'Reviewer view', x: 300, y: 300, config: { agentId: reviewer, prompt: 'Critique the risks: {{input.question}}' } },
          { id: 'merge', type: 'merge', name: 'Merge', x: 580, y: 200, config: {} },
          {
            id: 'decide',
            type: 'router',
            name: 'Decide',
            x: 800,
            y: 190,
            config: { mode: 'agent', agentId: engineer, question: 'Given both opinions, is the decision clear enough to proceed?', rules: [{ port: 'proceed', conditions: [] }, { port: 'discuss', conditions: [] }] },
          },
          { id: 'go', type: 'output', name: 'Proceed', x: 1060, y: 120, config: { text: '{{input.items}}', json: { status: 'done', decision: 'proceed' } } },
          { id: 'talk', type: 'output', name: 'Discuss', x: 1060, y: 280, config: { text: '{{input.items}}', json: { status: 'needs_review', decision: 'discuss' } } },
        ],
        edges: [
          { id: 'e1', from: 'start', fromPort: 'out', to: 'a', toPort: 'in' },
          { id: 'e2', from: 'start', fromPort: 'out', to: 'b', toPort: 'in' },
          { id: 'e3', from: 'a', fromPort: 'out', to: 'merge', toPort: 'in' },
          { id: 'e4', from: 'b', fromPort: 'out', to: 'merge', toPort: 'in' },
          { id: 'e5', from: 'merge', fromPort: 'out', to: 'decide', toPort: 'in' },
          { id: 'e6', from: 'decide', fromPort: 'proceed', to: 'go', toPort: 'in' },
          { id: 'e7', from: 'decide', fromPort: 'discuss', to: 'talk', toPort: 'in' },
          { id: 'e8', from: 'decide', fromPort: 'else', to: 'talk', toPort: 'in' },
        ],
      },
    },
  ];
}
