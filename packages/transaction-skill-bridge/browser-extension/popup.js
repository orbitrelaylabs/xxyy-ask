void render();

async function render() {
  await chrome.runtime.sendMessage({ type: 'ensure_connection' }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const state = await chrome.storage.local.get([
    'connectionStatus',
    'installationId',
    'lastConnectionAt',
    'lastConnectionError',
  ]);
  const status = document.querySelector('#status');
  status.textContent = state.connectionStatus || 'unknown';
  status.className = state.connectionStatus === 'connected' ? 'connected' : 'disconnected';
  document.querySelector('#installation-id').textContent = state.installationId || '—';
  document.querySelector('#updated-at').textContent = state.lastConnectionAt || '—';
  document.querySelector('#error').textContent = state.lastConnectionError || '—';
}
