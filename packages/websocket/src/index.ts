#!/usr/bin/env node

import { ConnectorRegistry } from '@governance-connector-framework/core';
import { loadExternalConnectors } from '@governance-connector-framework/core/loader';
import { RemoteConnectorService } from './server/RemoteConnectorService.js';
import { OAuthTokenProvider } from './server/OAuthTokenProvider.js';

function getArgValue(argv: readonly string[], name: string): string | undefined {
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === name) {
            return i + 1 < argv.length ? argv[i + 1] : undefined;
        }
        if (arg && arg.startsWith(`${name}=`)) {
            return arg.slice(name.length + 1);
        }
    }
    return undefined;
}

async function main() {
    const serverUrl = process.env.REMOTE_CONNECTOR_WS_URL;
    const tokenUrl = process.env.OAUTH_TOKEN_URL;
    const clientId = process.env.OAUTH_CLIENT_ID;
    const clientSecret = process.env.OAUTH_CLIENT_SECRET;

    if (!serverUrl) throw new Error("REMOTE_CONNECTOR_WS_URL must be set");
    if (!tokenUrl) throw new Error("OAUTH_TOKEN_URL must be set");
    if (!clientId) throw new Error("OAUTH_CLIENT_ID must be set");
    if (!clientSecret) throw new Error("OAUTH_CLIENT_SECRET must be set");

    const oauth = new OAuthTokenProvider({
        tokenUrl,
        clientId,
        clientSecret,
        scope: process.env.OAUTH_SCOPE,
        audience: process.env.OAUTH_AUDIENCE,
        resource: process.env.OAUTH_RESOURCE,
    });

    const registry = new ConnectorRegistry();

    const argv = process.argv.slice(2);
    const connectorsDir = getArgValue(argv, "--connectors") ?? process.env.CONNECTORS_DIR;
    if (connectorsDir) {
        console.log(`Loading external connectors from: ${connectorsDir}`);
        await loadExternalConnectors(connectorsDir, registry);
    } else {
        console.log("No external connectors directory provided. Use --connectors <dir> or CONNECTORS_DIR env.");
    }

    const service = new RemoteConnectorService({ serverUrl, registry, oauth });
    await service.start();

    const shutdown = async () => {
        console.log("Shutting down remote connector service");
        await service.shutdown();
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

export { main };

// Only run main if this is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}