export interface OAuthOptions {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope?: string | undefined;
    audience?: string | undefined;
    resource?: string | undefined;
}
export declare class OAuthTokenProvider {
    private readonly opts;
    private accessToken;
    private expiresAt;
    private readonly earlyExpiryMs;
    constructor(opts: OAuthOptions);
    invalidate(): void;
    private isTokenValid;
    getTokenExpiryTime(): number;
    getToken(): Promise<string>;
}
//# sourceMappingURL=OAuthTokenProvider.d.ts.map