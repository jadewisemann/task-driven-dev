import { boardView } from './board.js';
import { agentsView } from './agents.js';
import './board-agents.js';

/**
 * Registered top-level views, in navigation order.
 * A view is { id, title, icon, mount(root, ctx) -> cleanup? }.
 */
export const views = [boardView, agentsView];
