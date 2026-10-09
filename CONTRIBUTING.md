# Contributing

Thanks for taking an interest in Simurgh. The project is early-stage and its Phase 1 boundary is documented in [DESIGN.md](DESIGN.md): read-only Grafana context capture, explicit user confirmation, and inspectable provenance. Please discuss substantial changes before investing in an implementation.

## Branch workflow

- `dev` is the default branch and integration target for ongoing development.
- `main` is the stable release branch. Promote `dev` to `main` through a release pull request only after verification; do not push directly to `main`.
- Start short-lived `feat/<name>`, `fix/<name>`, or `docs/<name>` branches from an up-to-date `dev`, and open pull requests against `dev`.
- CI runs on pushes and pull requests to both long-lived branches. The required `checks` job must pass on an up-to-date release pull request before merging into `main`.
- Use merge commits for `dev` to `main` promotions so their shared history is preserved. Squash merges are suitable for short-lived feature branches.
- For an urgent released-version fix, branch `hotfix/<name>` from `main`, submit a verified pull request to `main`, then merge `main` back into `dev` through a pull request.
- Never force-push or delete either long-lived branch. Direct pushes to `dev` remain available to maintainers during the early MVP; contributor changes should use pull requests.

Start a contribution with:

```sh
git switch dev
git pull --ff-only origin dev
git switch -c feat/my-change
```

`main` requires a pull request, passing CI, and resolved review conversations, including for administrators. Independent review is encouraged; a mandatory approval count is not enabled while the project has a single maintainer. Passing CI is necessary, not proof of production readiness. Tag releases only after the release pull request is merged and its deployment/signing gates are met.

## Before opening a pull request

- Check existing issues and pull requests for related work.
- For behavior changes, describe the user workflow and how the change preserves target identity, scope, and provenance.
- Keep data access read-only and within the configured user's authorization. Do not add automatic investigation, remote actions, or broader collection without an approved design.
- Do not include real customer telemetry, credentials, internal hostnames, or personal data in source, screenshots, fixtures, tests, or issue reports. Use synthetic or local lab data.
- Keep changes focused, include or update tests for changed behavior, and document meaningful limitations.
- Do not commit generated credentials, build output, browser profiles, or machine-specific settings.

## Local checks

Use Node.js 20.19 or newer and npm 10 or newer; run these from the repository root:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

With the local Grafana lab running, install Playwright Chromium and run `npm run test:browser` to exercise the native panel-menu capture flow. The GitHub Actions workflow also starts the lab and runs this browser integration check.

For Grafana integration work, follow the local lab instructions in [README.md](README.md). The monitored kernel depends on the Docker Engine host: Docker Desktop's Linux VM with Docker Desktop, or the Linux host with native Docker. It does not validate a customer's host or deployment.

## Pull requests

Explain the problem, the change, and the user-visible effect. Include verification performed and known gaps. For UI or dashboard behavior, include a screenshot or short recording made with synthetic/local data. Call out any new permissions, data fields, network destinations, or changes to confirmation behavior.

Do not claim that local build checks establish production readiness. Release signing, supported-version policy, and customer deployment procedures are not yet defined.

## License and contributions

The project is distributed under the Apache License 2.0. Unless a contribution is explicitly marked otherwise, a contribution intentionally submitted for inclusion is offered under Apache-2.0 as described in section 5 of [LICENSE](LICENSE). No separate contributor agreement is currently required.
