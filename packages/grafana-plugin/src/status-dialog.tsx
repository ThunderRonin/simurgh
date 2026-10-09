import React from 'react';

type Props = { onDismiss?: () => void };

export function StatusDialog({ onDismiss }: Props) {
  return (
    <div style={{ padding: 20, maxWidth: 480 }}>
      <p>{statusMessage}</p>
      <button type="button" onClick={onDismiss}>Close</button>
    </div>
  );
}

let statusMessage = 'Install and enable the matching Simurgh Chromium extension, then open this panel action again.';

export function setStatusMessage(message: string) {
  statusMessage = message;
}
