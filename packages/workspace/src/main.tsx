import React from 'react';
import { createRoot } from 'react-dom/client';

import { WorkspaceApp } from './workspace-app';
import './workspace.css';

const mount = document.getElementById('root');
if (!mount) throw new Error('Workspace mount point is missing.');
createRoot(mount).render(<WorkspaceApp />);
