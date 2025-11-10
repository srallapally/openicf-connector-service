import { ConnectorRegistry } from '@openicf/connector-core';
import { OAuthTokenProvider } from "./OAuthTokenProvider.js";
interface RemoteConnectorServiceOptions {
    serverUrl: string;
    registry: ConnectorRegistry;
    oauth: OAuthTokenProvider;
    reconnectInitialDelayMs?: number;
    reconnectMaxDelayMs?: number;
}
export declare class RemoteConnectorService {
    private readonly opts;
    private ws;
    private reconnectDelayMs;
    private readonly reconnectInitialDelayMs;
    private readonly reconnectMaxDelayMs;
    private reconnectHandle;
    private readonly startedAt;
    private shuttingDown;
    private readonly facades;
    private connectionEstablishedAt;
    private currentTokenExpiresAt;
    private tokenCheckInterval;
    private readonly TOKEN_CHECK_INTERVAL_MS;
    private readonly TOKEN_REFRESH_BUFFER_MS;
    private readonly rateLimiter;
    constructor(opts: RemoteConnectorServiceOptions);
    start(): Promise<void>;
    shutdown(): Promise<void>;
    private populateFacades;
    private listConnectors;
    private getFacade;
    /**
     * Start periodic token validation checks
     * Security: Prevents expired/revoked tokens from remaining active
     */
    private startTokenValidationCheck;
    /**
     * Stop token validation checks
     */
    private stopTokenValidationCheck;
    /**
     * Check if current token is expired or about to expire
     * Proactively reconnect with fresh token before expiry
     */
    private checkTokenExpiry;
    private openConnection;
    private establishWebSocket;
    private scheduleReconnect;
    private send;
    private sendServiceInfo;
    private handleMessage;
    private handleOperation;
    private sanitizeOptions;
    private expectString;
    private expectRecord;
    private performOperation;
}
export {};
//# sourceMappingURL=RemoteConnectorService.d.ts.map