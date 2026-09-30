/**
 * Extension points for the board so features (agents, runner, ...) can add UI
 * without the board knowing about them.
 *
 * ext = {
 *   id: string,
 *   events?: string[],                          // event type prefixes that should refresh the board
 *   load?(ctx) => Promise<any>,                 // extra data, available as data[ext.id]
 *   toolbar?(data, ctx, reload) => Node,        // rendered in the board toolbar
 *   aside?(data, ctx, reload) => Node,          // rendered above the columns (e.g. agent roster)
 *   cardFooter?(task, data, ctx) => Node,       // rendered at the bottom of each card
 *   onCardDrop?(task, dataTransfer, ctx) => boolean|Promise<boolean>, // handle custom drops on a card
 *   drawerSection?(task, data, ctx, reload) => Node, // rendered inside the task drawer
 * }
 */
export const boardExtensions = [];

export function registerBoardExtension(ext) {
  if (!boardExtensions.some((e) => e.id === ext.id)) boardExtensions.push(ext);
}
