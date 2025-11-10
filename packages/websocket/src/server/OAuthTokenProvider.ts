export interface OAuthOptions {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope?: string | undefined;
    audience?: string | undefined;
    resource?: string | undefined;
}

export class OAuthTokenProvider {
    private accessToken: string | null = null;
    private expiresAt = 0;
    private readonly earlyExpiryMs = 30_000;

    constructor(private readonly opts: OAuthOptions) {}

    invalidate() {
        this.accessToken = null;
        this.expiresAt = 0;
    }

    private isTokenValid() {
        return this.accessToken && Date.now() + this.earlyExpiryMs < this.expiresAt;
    }

    getTokenExpiryTime(): number {
        return this.expiresAt;
    }

    async getToken(): Promise<string> {
        if (this.isTokenValid()) return this.accessToken!;

        const body = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: this.opts.clientId,
            client_secret: this.opts.clientSecret,
        });
        if (this.opts.scope) body.set("scope", this.opts.scope);
        if (this.opts.audience) body.set("audience", this.opts.audience);
        if (this.opts.resource) body.set("resource", this.opts.resource);

        const res = await fetch(this.opts.tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`OAuth token request failed (${res.status} ${res.statusText}): ${text.slice(0, 200)}`);
        }

        const json = (await res.json()) as Record<string, unknown>;
        const token = typeof json.access_token === "string" ? json.access_token : null;
        if (!token) throw new Error("OAuth token response missing access_token");

        const expires = typeof json.expires_in === "number"
            ? json.expires_in
            : typeof json.expires_in === "string"
                ? Number.parseInt(json.expires_in, 10)
                : null;
        const expiresInSec = Number.isFinite(expires) && expires! > 0 ? expires! : 300;

        this.accessToken = token;
        this.expiresAt = Date.now() + expiresInSec * 1000;
        return token;
    }
}