export class GraphConfiguration {
  constructor(
    public readonly tenantId: string,
    public readonly clientId: string,
    public readonly clientSecret: string
  ) {}
  async validate() {
    for (const [k,v] of Object.entries({ tenantId: this.tenantId, clientId: this.clientId, clientSecret: this.clientSecret })) {
      if (typeof v !== "string" || v.trim() === "") throw new Error(`Configuration property '${k}' is required`);
    }
  }
}
export async function buildConfiguration(raw: any): Promise<GraphConfiguration> {
  return new GraphConfiguration(raw?.tenantId, raw?.clientId, raw?.clientSecret);
}
