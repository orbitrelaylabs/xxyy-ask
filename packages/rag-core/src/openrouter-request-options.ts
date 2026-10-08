/** Reserve the short support/planner output budgets for the requested response. */
export function getOpenRouterFreeModelOptions(
  baseUrl: string,
  model: string,
): { reasoning?: { enabled: false } } {
  if (!model.endsWith(':free') && model !== 'openrouter/free') return {};
  try {
    if (new URL(baseUrl).origin === 'https://openrouter.ai') {
      return { reasoning: { enabled: false } };
    }
  } catch {
    // Leave invalid endpoint handling to the request layer.
  }
  return {};
}
