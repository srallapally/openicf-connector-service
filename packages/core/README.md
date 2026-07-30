# @governance-connector-framework/core

Transport-independent connector framework. This document covers how connector
instances are configured, how environment substitution behaves, and how to
handle secrets.

## Instance bootstrap

`loadExternalConnectors(dir, registry)` scans `dir` for subdirectories
containing a `manifest.json`. Instances for a connector come from exactly one
of two sources, in this order:

1. **`manifest.instances`** — if present, it is used.
2. **`instances.json`** — read from the connector directory only when the
   manifest declares no instances.

**The two are never merged.** If a manifest declares instances, `instances.json`
is not consulted at all. A silent union of the two is how duplicate instance ids
arise, and duplicates are a hard error at registration (see below).

`instances.json` is a JSON array:

```json
[
  {
    "id": "crm-prod",
    "config": { "baseUrl": "https://crm.internal", "apiKey": "${CRM_API_KEY}" }
  },
  {
    "id": "crm-staging",
    "connectorVersion": "1.2.0",
    "config": { "baseUrl": "https://crm-staging.internal", "apiKey": "${CRM_STAGING_KEY}" }
  }
]
```

Each entry takes `id` (required), `config` (merged over the connector's base
config), and optionally `connectorVersion` to pin a version other than the
manifest's.

Failure behaviour:

| Situation | Result |
|---|---|
| No `instances.json`, no `manifest.instances` | `[external] <id>: no instances defined` warning; nothing registered |
| `instances.json` absent | Silent — an absent file is a normal choice |
| `instances.json` present but unparseable | `[external] <id>: invalid instances.json: <reason>` error; that connector registers no instances; **other connectors still load** |
| Duplicate instance id | Registration throws; the loader reports `[external] failed to load <id>` and continues with other directories |

Because the loader's error handling wraps a whole connector directory, a
duplicate id *within a single manifest* abandons that connector's remaining
instances. A manifest with repeated ids is malformed; a partial load with a
loud error is preferred over silently overwriting an instance.

### Environment-variable instance configs are not supported

`CONNECTOR_INSTANCES` and `CONNECTOR_INSTANCES_<ID>` were removed. Passing whole
instance configurations — credentials included — as a JSON blob in an
environment variable puts secrets into process listings, crash dumps and
orchestrator manifests. Use `instances.json` with `${ENV}` substitution for the
individual sensitive values instead.

## `${ENV}` substitution

Any string in a connector or instance config may be replaced wholesale by an
environment variable:

```json
{ "apiKey": "${CRM_API_KEY}" }
```

The rules, exactly as implemented:

- **Full-string only.** The value must be *entirely* `${VAR}`. The pattern is
  anchored: `^\$\{([A-Z0-9_]+)\}$`.
- **Variable names are `[A-Z0-9_]+`.** Lowercase names do not match and are
  left as literal text.
- **A missing variable fails that connector.** The load throws, the loader
  reports `[external] failed to load <id>`, and other connectors continue.
- Substitution walks nested objects and arrays.

Interior interpolation is **deliberately unsupported**:

```json
{ "url": "https://user:${PASSWORD}@host/db" }   // NOT substituted — stays literal
{ "password": "${PASSWORD}" }                    // substituted
```

This is not an oversight. A secret embedded in a URL or connection string
travels wherever that string travels — logs, error messages, metrics labels,
traces. Keeping credentials as their own config fields is what makes redaction
and `GuardedString` able to do anything at all.

## Secrets

### Registry listings are redacted

`registry.list()` masks configuration values: keys matching
`/pass|secret|token|key/i` become `"***"`, as does any `GuardedString`
regardless of its key. `list()` is the debugging and inspection API, so its
output is what ends up in logs.

`registry.get(id)` and `registry.getSpi(id)` are **not** redacted — operations
need the real configuration.

The key pattern over-matches on purpose: `tokenUrl` and `publicKeyPath` are not
secrets but come back masked. For a listing API that is the right direction to
err.

### `GuardedString`

Opt-in wrapper for secrets held in memory. Nothing wraps values automatically —
wrap deliberately in your connector's `buildConfiguration`:

```ts
import { GuardedString } from "@governance-connector-framework/core/spi";

export async function buildConfiguration(raw: any) {
  return {
    baseUrl: raw.baseUrl,
    apiKey: new GuardedString(raw.apiKey),   // wrap after read
  };
}
```

Use it at the point of need, and drop it on teardown:

```ts
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${config.apiKey.reveal()}` },   // deliberate
});

async dispose() {
  config.apiKey.clear();
}
```

Automatic wrapping in the loader was considered and rejected: key-pattern
matching would wrap `tokenUrl` and `publicKeyPath`, and connectors would have to
unwrap values that were never sensitive.

#### What `GuardedString` does and does not do

It protects against **accidental disclosure**. Template interpolation,
`String()`, `JSON.stringify`, `util.inspect` and therefore `console.log`, and
error messages built by interpolation all yield `[REDACTED]`.

It does **not**:

- **Zero memory.** JavaScript strings are immutable and the garbage collector
  decides when the backing storage is released. `clear()` drops a reference; it
  scrubs nothing.
- **Protect a secret that already existed as a plain string.** The value was
  read from a file, an environment variable or a response before it was wrapped,
  and copies may survive in those buffers.
- **Stop deliberate disclosure.** A connector that calls `reveal()` and logs the
  result has leaked the secret. That is precisely why `reveal()` is a named,
  greppable method rather than a transparent getter — so every place a secret
  is unwrapped can be found and reviewed.

It also does not survive serialization: `structuredClone` or a JSON round trip
produces a husk containing no secret. That is a safe failure, and it is covered
by tests rather than worked around.
