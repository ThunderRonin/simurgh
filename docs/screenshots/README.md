# README screenshots

These unmodified screenshots were captured on October 9, 2026 from the local developer MVP. They were visually reviewed before publication: no access tokens, credentials, customer telemetry, personal filesystem paths, or unrelated browser tabs are visible. Alice is the local lab account name.

| Image | What it demonstrates | Provenance |
| --- | --- | --- |
| `grafana-confirmed-selection.png` | Explicit CPU 0 confirmation and export controls after a freehand capture in Firefox. | Real installed-extension acceptance run against Grafana 13.2.3/uPlot 1.6.32 using Linux Firefox 157.0.1. Original artifact: `test-results/firefox/freehand-confirmed-firefox.png`. |
| `investigation-evidence.png` | A completed local investigation with telemetry and source references, baseline comparison, citations, and limitations. | Real local workspace/coordinator and configured Codex agent, not the mocked workspace fixture server. The source reference is the editor test fixture `test/fixtures/selected.ts`; telemetry comes from the local Docker lab. |

The two images come from separate local runs and do not represent one shared selection interval. The first shows the confirmation state, not the drawing gesture. The second retains its actual finding and warnings; source selection does not establish runtime execution or causation. Voice controls being visible do not demonstrate microphone testing.

To refresh these images, repeat the documented [Firefox flow](../firefox.md) and [local workspace flow](../local-mvp.md) with local lab data. Capture a completed, readable state with no dialogs or personal browser chrome, inspect every visible field for private data, and preserve provenance and limitations in the captions. Do not replace actual findings with presentation-only text.
