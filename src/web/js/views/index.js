import { boardView } from './board.js';
import { agentsView } from './agents.js';
import { workflowsView } from './workflows.js';
import { runsView } from './runs.js';
import { flowView } from './flow.js';
import './board-agents.js';
import './board-runner.js';
import './agents-graph.js';

/**
 * Registered top-level views, in navigation order.
 * A view is { id, title, icon, mount(root, ctx) -> cleanup? }.
 */
export const views = [boardView, flowView, agentsView, workflowsView, runsView];
