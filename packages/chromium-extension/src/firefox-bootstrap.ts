const grafanaOrigins = new Set([
  'http://localhost:3300',
  'http://127.0.0.1:3300',
]);

if (grafanaOrigins.has(window.location.origin)) {
  void import('./content');
}
