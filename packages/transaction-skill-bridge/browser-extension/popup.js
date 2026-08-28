void render();

async function render() {
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
