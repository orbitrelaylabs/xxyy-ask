import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AdminApp } from './AdminApp.js';
import './admin.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Unable to mount XXYY Admin: #root is missing.');
}

createRoot(root).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
