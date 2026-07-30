# @governance-connector-framework/websocket

Deployable WebSocket server that connects outbound to a remote control-plane
and dispatches connector operations through
`@governance-connector-framework/core`.

---

## Installation

### From source (monorepo)

```bash
git clone https://github.com/srallapally/governance-connector-framework.git
cd governance-connector-framework
npm ci
npm run build
cd packages/websocket
```

### Container (recommended for production)

```bash
docker pull ghcr.io/srallapally/governance-connector-framework/websocket:<version>
```

Replace `<version>` with the tag from the [Releases page](https://github.com/srallapally/governance-connector-framework/releases).

---

## Required environment variables

| Variable | Description |
|---|---|
| `REMOTE_CONNECTOR_WS_URL` | WebSocket URL of the remote control plane (`wss://…`) |
| `OAUTH_TOKEN_URL` | Token endpoint for the `client_credentials` OAuth grant |
| `OAUTH_CLIENT_ID` | OAuth client ID |
| `OAUTH_CLIENT_SECRET` | OAuth client secret |

### Optional

| Variable | Default | Description |
|---|---|---|
| `CONNECTOR_PLUGINS_DIR` | — | Directory scanned for connector plugin subdirectories |
| `JWT_JWKS_URI` | — | JWKS endpoint for incoming JWT validation (required when HTTP routes are used) |
| `JWT_EXPECTED_ISS` | — | Expected `iss` claim |
| `JWT_EXPECTED_AUD` | — | Expected `aud` claim |
| `JWT_ALLOWED_ALGS` | `RS256,PS256,ES256` | Comma-separated list of allowed signing algorithms |
| `JWT_ACCEPTED_CLOCK_SKEW_SEC` | `60` | Maximum clock skew in seconds (max 300) |
| `JWT_MAX_TOKEN_AGE_SEC` | `86400` | Maximum token age in seconds (max 604800 / 7 days) |

---

## Quick start

```bash
docker run --rm \
  -e REMOTE_CONNECTOR_WS_URL=wss://control-plane.example.com/ws \
  -e OAUTH_TOKEN_URL=https://auth.example.com/oauth2/token \
  -e OAUTH_CLIENT_ID=my-client \
  -e OAUTH_CLIENT_SECRET=my-secret \
  ghcr.io/srallapally/governance-connector-framework/websocket:1.0.0
```

---

## Loading connector plugins

Place each connector in its own subdirectory under `$CONNECTOR_PLUGINS_DIR`.
Every subdirectory must contain a `manifest.json`:

```json
{
  "type": "ldap",
  "version": "2.1.0",
  "entry": "./index.js",
  "instances": [
    {
      "id": "corporate-ldap",
      "config": {
        "host": "${LDAP_HOST}",
        "port": 636,
        "bindDn": "${LDAP_BIND_DN}",
        "password": "${LDAP_BIND_PASSWORD}"
      }
    }
  ]
}
```

`${ENV_VAR}` placeholders are resolved at load time.

---

## Architecture

The server connects **outbound** to the control plane — it does not expose an
inbound port. This allows deployment behind a firewall with no ingress rules.

```
[Connector Plugins]
       │
       ▼
 ExternalLoader  ──▶  ConnectorRegistry  ──▶  ConnectorFacade
                                                     │
                                                     ▼
                                          RemoteConnectorService
                                                     │  wss://
                                                     ▼
                                             Control Plane
```

`RemoteConnectorService` handles OAuth token acquisition, proactive
re-authentication before token expiry, and exponential-backoff reconnection.

---

## Development

```bash
# Run without compiling (uses tsx)
REMOTE_CONNECTOR_WS_URL=wss://… \
OAUTH_TOKEN_URL=https://… \
OAUTH_CLIENT_ID=… \
OAUTH_CLIENT_SECRET=… \
npm run dev

# Run tests
npm test
```
