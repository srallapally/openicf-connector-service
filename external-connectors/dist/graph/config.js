export class GraphConfiguration {
    tenantId;
    clientId;
    clientSecret;
    constructor(tenantId, clientId, clientSecret) {
        this.tenantId = tenantId;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
    }
    async validate() {
        for (const [k, v] of Object.entries({ tenantId: this.tenantId, clientId: this.clientId, clientSecret: this.clientSecret })) {
            if (typeof v !== "string" || v.trim() === "")
                throw new Error(`Configuration property '${k}' is required`);
        }
    }
}
export async function buildConfiguration(raw) {
    return new GraphConfiguration(raw?.tenantId, raw?.clientId, raw?.clientSecret);
}
