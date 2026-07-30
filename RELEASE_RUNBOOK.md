# Release Runbook

This document describes how to cut a release for each package in this monorepo.

---

## Packages and tag conventions

| Package | Tag pattern | Example |
|---|---|---|
| `@governance-connector-framework/core` | `core-v<semver>` | `core-v1.6.1` |
| `@governance-connector-framework/websocket` | `websocket-v<semver>` | `websocket-v1.0.1` |

Tags trigger the corresponding GitHub Actions workflow in `.github/workflows/`.

---

## Pre-release checklist

- [ ] All tests pass on `main`: `npm ci && npm run build && npm test`
- [ ] `packages/core/package.json` version field updated (if releasing core)
- [ ] `packages/websocket/package.json` version field updated (if releasing websocket)
- [ ] `packages/websocket` dependency on `@governance-connector-framework/core` points to the correct published version (`^<new-core-version>`)
- [ ] CHANGELOG or release notes drafted

---

## Releasing `@governance-connector-framework/core`

1. Bump the version in `packages/core/package.json`.

2. Commit the version bump:
   ```bash
   git add packages/core/package.json
   git commit -m "chore(core): bump version to 1.x.y"
   ```

3. Tag and push:
   ```bash
   git tag core-v1.x.y
   git push origin main core-v1.x.y
   ```

4. GitHub Actions (`release-core.yml`) will:
   - Build and test the core package
   - Run `npm pack` to produce `governance-connector-framework-core-1.x.y.tgz`
   - Create a GitHub Release with the tarball attached

5. Verify the release at `https://github.com/srallapally/governance-connector-framework/releases`.

---

## Releasing `@governance-connector-framework/websocket`

### Prerequisites

- Core must already be released at the version listed in `websocket/package.json`'s
  `dependencies` (or resolve correctly via the npm registry / workspace).
- A `GITHUB_TOKEN` with `packages: write` is automatically provided by GitHub
  Actions — no manual token setup is required.

### Steps

1. Bump the version in `packages/websocket/package.json`.

2. Commit:
   ```bash
   git add packages/websocket/package.json
   git commit -m "chore(websocket): bump version to 1.x.y"
   ```

3. Tag and push:
   ```bash
   git tag websocket-v1.x.y
   git push origin main websocket-v1.x.y
   ```

4. GitHub Actions (`release-websocket.yml`) will:
   - Run the full test suite (`npm test`)
   - Build and push the container image to GHCR:
     ```
     ghcr.io/srallapally/governance-connector-framework/websocket:1.x.y
     ghcr.io/srallapally/governance-connector-framework/websocket:latest
     ```
   - Create a GitHub Release with pull instructions

5. Verify:
   ```bash
   docker pull ghcr.io/srallapally/governance-connector-framework/websocket:1.x.y
   ```

---

## Rolling back a release

GitHub does not delete published container images or release tarballs
automatically. To roll back:

- **Core tarball**: delete the GitHub Release asset and re-tag the previous commit.
- **Container image**: delete the specific version tag from GHCR
  (`https://github.com/srallapally/governance-connector-framework/pkgs/container/governance-connector-framework%2Fwebsocket`),
  then re-tag `latest` to the previous image digest.

---

## Versioning policy

Both packages follow [Semantic Versioning](https://semver.org/):

- **PATCH** — bug fixes, no API changes
- **MINOR** — new backwards-compatible SPI ops or configuration options
- **MAJOR** — breaking changes to `ConnectorSpi`, `ConnectorRegistry`, or the
  WebSocket message protocol
