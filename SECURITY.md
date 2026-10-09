# Security policy

Simurgh is an early-stage project. No production deployment or security support commitment is currently made.

## Reporting a vulnerability

Please do not disclose suspected vulnerabilities in a public issue. Use GitHub's private vulnerability reporting for this repository when it is enabled. If it is unavailable, ask the maintainers to establish a private reporting channel before sharing technical details. Include affected commit or release, prerequisites, impact, and concise reproduction steps. Do not include real customer data or secrets.

Maintainers will acknowledge reports as soon as practical, assess impact and affected versions, and coordinate a fix and disclosure timeline with the reporter. Do not test against systems or data you do not own or have explicit permission to assess.

## Scope and handling

The initial security focus is on browser/Grafana message validation, origin and source checks, stale snapshot rejection, least-privilege access, and preventing dashboard content from triggering network or privileged actions. Treat telemetry, dashboard labels, queries, and logs as potentially sensitive input.

The local lab intentionally permits one unsigned plugin (`simurgh-context-app`) and exposes Grafana on loopback for development. This is not a production security configuration. Do not carry the unsigned-plugin allowance, demo credentials, anonymous Viewer access, or lab endpoints into a customer deployment. The lab does not mount host secrets, the Docker socket, or broad host root, and it does not monitor the Windows host.

No security advisories or supported release ranges are defined yet. Report the exact commit when describing a potential issue.

## Development dependency audit

As of 2026-10-09, `npm audit` reports 4 moderate advisories and no high or critical advisories in the Grafana 13.2.3 host dependency tree. The reported paths involve `routercompat` and `react-router` (GHSA-wrjc-x8rr-h8h6 and GHSA-337j-9hxr-rhxg). These are host-provided Grafana UI dependencies; this note does not claim that Grafana is unaffected or that the plugin's externalized dependencies make the host advisories irrelevant. Do not apply unreviewed overrides or downgrades. Re-run the audit against the current lockfile and assess upstream fixes before release.
