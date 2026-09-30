/**
 * Agents are asked (see RESULT_CONTRACT) to finish with a fenced ```json block.
 * This extracts the last such block (or a trailing bare JSON object).
 */
export function parseResult(output = '') {
  const fenced = [...output.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(fenced[i][1]);
      if (value && typeof value === 'object') return value;
    } catch {
      /* try an earlier block */
    }
  }
  const lastBrace = output.lastIndexOf('\n{');
  if (lastBrace !== -1) {
    try {
      const value = JSON.parse(output.slice(lastBrace + 1).trim());
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

/** Maps an agent-reported status onto a board status. */
export function boardStatusFor(result, exitOk) {
  if (!exitOk) return 'failed';
  switch (result?.status) {
    case 'failed':
    case 'error':
      return 'failed';
    case 'needs_review':
    case 'review':
      return 'review';
    default:
      return 'done';
  }
}
