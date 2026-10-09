# Project instructions

Read [DESIGN.md](DESIGN.md) and [CONTEXT.md](CONTEXT.md) before changing product behavior. Phase 1 is a read-only Grafana context inspector: selection, resolution, correction or confirmation, then inspection of a provenance-bearing snapshot. Preserve user authorization, scope, and evidence boundaries.

## Development

- Use Node.js 20.19 or newer and npm 10 or newer. From the repository root: `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`.
- For Grafana integration changes, use the reproducible local Docker lab in [README.md](README.md). It monitors the Docker Engine host kernel (Docker Desktop's Linux VM with Docker Desktop, or the Linux host with native Docker), not Windows CPU or a customer host.
- Add focused tests for behavior changes. Use synthetic/local data in tests, fixtures, screenshots, and logs; never commit credentials or customer telemetry.
- Keep browser permissions, network destinations, and data collection narrow and documented. Dashboard content and telemetry are untrusted input.
- Public contributors can use GitHub issues and pull requests; Beads is optional outside the maintainers' local workflow.
- Do not commit, push, merge, or close Beads issues without explicit authorization and completed verification. Never close an issue automatically as a session cleanup step.

See [CONTRIBUTING.md](CONTRIBUTING.md) for pull request expectations and [SECURITY.md](SECURITY.md) for vulnerability reporting.
