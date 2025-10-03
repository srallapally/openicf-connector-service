import type {
  ConnectorSpi,
  ConnectorObject,
  OperationOptions,
  AttributeValue,
  Schema,
  ResultsHandler,
  SearchResult,
  SyncToken,
} from "../spi-types.js";
import { GraphConfiguration } from "./config.js";

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

class TokenCache {
  private accessToken: string | null = null;
  private expiresAt = 0;
  constructor(private cfg: GraphConfiguration) {}
  async get(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.accessToken && now < this.expiresAt - 60) return this.accessToken;

    const url = `https://login.microsoftonline.com/${encodeURIComponent(
        this.cfg.tenantId
    )}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      scope: "https://graph.microsoft.com/.default",
    });

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`Azure AD token error: ${res.status} ${await res.text()}`);
    const json: any = await res.json();
    this.accessToken = json.access_token;
    this.expiresAt = Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600);
    return this.accessToken!;
  }
}

class GraphClient {
  private token: TokenCache;
  constructor(private cfg: GraphConfiguration) {
    this.token = new TokenCache(cfg);
  }

  // ⬅ made public so callers outside the class can use it
  async request<T>(
      method: HttpMethod,
      path: string,
      query?: Record<string, string | number | boolean | undefined>,
      body?: any
  ): Promise<T> {
    const at = await this.token.get();
    const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Graph ${method} ${url.pathname}${url.search} => ${res.status}: ${await res.text()}`);
    if (res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
  }

  async requestByUrl<T>(urlStr: string): Promise<T> {
    const at = await this.token.get();
    const res = await fetch(urlStr, { headers: { Authorization: `Bearer ${at}` } });
    if (!res.ok) throw new Error(`Graph GET ${urlStr} => ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  // Users
  listUsers(select?: string, top?: number, filter?: string) {
    return this.request<any>("GET", "/users", { $select: select, $top: top, $filter: filter });
  }
  getUser(id: string, select?: string) {
    return this.request<any>("GET", `/users/${id}`, { $select: select });
  }
  createUser(attrs: Record<string, any>) {
    return this.request<any>("POST", "/users", undefined, attrs);
  }
  updateUser(id: string, attrs: Record<string, any>) {
    return this.request<any>("PATCH", `/users/${id}`, undefined, attrs);
  }
  deleteUser(id: string) {
    return this.request<void>("DELETE", `/users/${id}`);
  }

  // Groups
  listGroups(select?: string, top?: number, filter?: string) {
    return this.request<any>("GET", "/groups", { $select: select, $top: top, $filter: filter });
  }
  getGroup(id: string, select?: string) {
    return this.request<any>("GET", `/groups/${id}`, { $select: select });
  }
  createGroup(attrs: Record<string, any>) {
    return this.request<any>("POST", "/groups", undefined, attrs);
  }
  updateGroup(id: string, attrs: Record<string, any>) {
    return this.request<any>("PATCH", `/groups/${id}`, undefined, attrs);
  }
  deleteGroup(id: string) {
    return this.request<void>("DELETE", `/groups/${id}`);
  }

  // Service Principals
  listServicePrincipals(select?: string, top?: number, filter?: string) {
    return this.request<any>("GET", "/servicePrincipals", { $select: select, $top: top, $filter: filter });
  }
  getServicePrincipal(id: string, select?: string) {
    return this.request<any>("GET", `/servicePrincipals/${id}`, { $select: select });
  }
  createServicePrincipal(attrs: Record<string, any>) {
    return this.request<any>("POST", "/servicePrincipals", undefined, attrs);
  }
  updateServicePrincipal(id: string, attrs: Record<string, any>) {
    return this.request<any>("PATCH", `/servicePrincipals/${id}`, undefined, attrs);
  }
  deleteServicePrincipal(id: string) {
    return this.request<void>("DELETE", `/servicePrincipals/${id}`);
  }

  // Roles & Plans
  listDirectoryRoles(select?: string, top?: number) {
    return this.request<any>("GET", "/directoryRoles", { $select: select, $top: top });
  }
  getDirectoryRole(id: string, select?: string) {
    return this.request<any>("GET", `/directoryRoles/${id}`, { $select: select });
  }
  listSubscribedSkus() {
    return this.request<any>("GET", "/subscribedSkus");
  }

  // Teams & Channels
  listTeams(top?: number) {
    return this.request<any>("GET", "/groups", {
      $filter: "resourceProvisioningOptions/Any(x:x eq 'Team')",
      $top: top,
    });
  }
  getTeam(id: string) {
    return this.request<any>("GET", `/teams/${id}`).catch(async () =>
        this.request<any>("GET", `/groups/${id}`)
    );
  }
  listChannels(teamId: string, top?: number) {
    return this.request<any>("GET", `/teams/${teamId}/channels`, { $top: top });
  }
  getChannel(teamId: string, channelId: string) {
    return this.request<any>("GET", `/teams/${teamId}/channels/${channelId}`);
  }
}

function toConnectorObject(
    objectClass: string,
    id: string,
    attrs: any,
    nameField = "displayName"
): ConnectorObject {
  return {
    objectClass,
    uid: id,
    name: typeof attrs[nameField] === "string" ? attrs[nameField] : undefined,
    attributes: attrs as Record<string, AttributeValue>,
  };
}

// AST → OData filter (subset)
type AstNode =
    | { type: "CMP"; op: "EQ" | "CONTAINS" | "STARTS_WITH" | "ENDS_WITH"; path: string[]; value: string | number | boolean }
    | { type: "AND"; nodes: AstNode[] }
    | { type: "OR"; nodes: AstNode[] }
    | { type: "NOT"; node: AstNode };

function astToOData(node: AstNode, allowed: Set<string>): string {
  const field = (path: string[]) => {
    if (path.length !== 1) throw new Error("Nested filters not supported for Graph yet");
    const f = path[0];
    if (!allowed.has(f)) throw new Error(`Filtering not allowed on '${f}'`);
    return f;
  };
  const esc = (s: string) => `'${s.replace(/'/g, "''")}'`;

  const walk = (n: AstNode): string => {
    switch (n.type) {
      case "CMP": {
        const f = field(n.path);
        const v = typeof n.value === "string" ? esc(String(n.value)) : String(n.value);
        switch (n.op) {
          case "EQ": return `${f} eq ${v}`;
          case "CONTAINS": return `contains(${f}, ${v})`;
          case "STARTS_WITH": return `startswith(${f}, ${v})`;
          case "ENDS_WITH": return `endswith(${f}, ${v})`;
        }
      }
      case "AND": return `(${n.nodes.map(walk).join(" and ")})`;
      case "OR":  return `(${n.nodes.map(walk).join(" or ")})`;
      case "NOT": return `(not ${walk(n.node)})`;
    }
  };
  return walk(node);
}

export default async function factory(config: GraphConfiguration): Promise<ConnectorSpi> {
  await config.validate();
  const client = new GraphClient(config);

  function toSelect(options?: OperationOptions): string | undefined {
    if (!options?.attributesToGet || !options.attributesToGet.length) return undefined;
    return options.attributesToGet.filter((a) => !a.includes(".")).slice(0, 60).join(",");
  }

  const schema: Schema = {
    features: { paging: true, sorting: false, complexAttributes: true },
    objectClasses: [
      oc("__ACCOUNT__", "User", [
        s("id", "string", { readable: true, returnedByDefault: true }),
        s("userPrincipalName", "string", { creatable: true, updateable: true, readable: true, returnedByDefault: true }),
        s("displayName", "string", { creatable: true, updateable: true, readable: true, returnedByDefault: true }),
        s("mail", "string", { readable: true }),
        s("givenName", "string", { creatable: true, updateable: true, readable: true }),
        s("surname", "string", { creatable: true, updateable: true, readable: true }),
        s("accountEnabled", "boolean", { creatable: true, updateable: true, readable: true }),
        s("passwordProfile", "complex", { creatable: true, updateable: false, readable: false }),
        s("identities", "complex", { readable: true, multiValued: true }),
      ], ["CREATE", "UPDATE", "DELETE", "GET", "SEARCH", "SYNC"]),
      oc("__GROUP__", "Group", [
        s("id", "string", { readable: true, returnedByDefault: true }),
        s("displayName", "string", { creatable: true, updateable: true, readable: true, returnedByDefault: true }),
        s("description", "string", { creatable: true, updateable: true, readable: true }),
        s("mail", "string", { readable: true }),
        s("mailEnabled", "boolean", { creatable: true, updateable: true, readable: true }),
        s("mailNickname", "string", { creatable: true, updateable: true, readable: true }),
        s("securityEnabled", "boolean", { creatable: true, updateable: true, readable: true }),
        s("groupTypes", "string", { multiValued: true, creatable: true, updateable: true, readable: true }),
      ], ["CREATE", "UPDATE", "DELETE", "GET", "SEARCH", "SYNC"]),
      oc("ServicePrincipal", "ServicePrincipal", [
        s("id", "string", { readable: true, returnedByDefault: true }),
        s("displayName", "string", { creatable: true, updateable: true, readable: true, returnedByDefault: true }),
        s("appId", "string", { readable: true }),
        s("servicePrincipalType", "string", { readable: true }),
      ], ["CREATE", "UPDATE", "DELETE", "GET", "SEARCH"]),
      oc("UserManagedIdentity", "ServicePrincipal", [
        s("id", "string", { readable: true, returnedByDefault: true }),
        s("displayName", "string", { readable: true, returnedByDefault: true }),
        s("servicePrincipalType", "string", { readable: true }),
      ], ["GET", "SEARCH"]),
      oc("Role", "DirectoryRole", [
        s("id", "string", { readable: true, returnedByDefault: true }),
        s("displayName", "string", { readable: true, returnedByDefault: true }),
        s("roleTemplateId", "string", { readable: true }),
      ], ["GET", "SEARCH"]),
      oc("ServicePlan", "SubscribedSku", [
        s("skuId", "string", { readable: true, returnedByDefault: true }),
        s("skuPartNumber", "string", { readable: true, returnedByDefault: true }),
        {
          name: "servicePlans",
          type: "complex",
          multiValued: true,
          readable: true,
          returnedByDefault: true,
          subAttributes: [
            s("servicePlanId", "string", { readable: true }),
            s("servicePlanName", "string", { readable: true }),
            s("provisioningStatus", "string", { readable: true }),
            s("appliesTo", "string", { readable: true }),
          ],
        } as any,
      ], ["GET", "SEARCH"]),
      oc("Team", "Team", [
        s("id", "string", { readable: true, returnedByDefault: true }),
        s("displayName", "string", { readable: true, returnedByDefault: true }),
      ], ["GET", "SEARCH"]),
      oc("Channel", "Channel", [
        s("id", "string", { readable: true, returnedByDefault: true }),
        s("displayName", "string", { readable: true, returnedByDefault: true }),
        s("teamId", "string", { readable: true, returnedByDefault: true }),
      ], ["GET", "SEARCH"]),
    ],
  };

  function schemaObj(): Schema {
    return schema;
  }

  // Combined search: supports list & streaming forms
  async function search(
      objectClass: string,
      filter: any,
      handlerOrOptions?: ResultsHandler | OperationOptions,
      maybeOptions?: OperationOptions
  ): Promise<any> {
    const streaming = typeof handlerOrOptions === "function";
    const handler: ResultsHandler | null = streaming ? (handlerOrOptions as ResultsHandler) : null;
    const options: OperationOptions | undefined = streaming
        ? maybeOptions
        : (handlerOrOptions as OperationOptions | undefined);

    const top = Math.min(Math.max(options?.pageSize ?? 50, 1), 200);
    const select = toSelect(options);
    const ocName = normalizeClass(objectClass);
    const filterFields: Record<string, Set<string>> = {
      User: new Set(["id", "userPrincipalName", "displayName", "mail", "givenName", "surname"]),
      Group: new Set(["id", "displayName", "mail", "mailNickname"]),
      ServicePrincipal: new Set(["id", "displayName", "appId", "servicePrincipalType"]),
      UserManagedIdentity: new Set(["id", "displayName", "servicePrincipalType"]),
      Role: new Set(["id", "displayName"]),
      ServicePlan: new Set(["skuId", "skuPartNumber", "capabilityStatus"]),
      Team: new Set(["id", "displayName"]),
      Channel: new Set(["id", "displayName"]),
    };
    const filterStr = filter ? astToOData(filter as any, filterFields[ocName] || new Set()) : undefined;

    const collect: ConnectorObject[] = [];
    const push = async (obj: ConnectorObject) => {
      if (streaming) {
        const cont = await (handler as ResultsHandler)(obj);
        return cont !== false;
      }
      collect.push(obj);
      return true;
    };

    const pageAndEmit = async (path: string, query: any, mapItem: (x: any) => ConnectorObject) => {
      let nextUrl: string | null = null;
      let first = true;
      for (;;) {
        let json: any;
        if (first) {
          json = await client.request<any>("GET", path, { ...query, $top: top });
          first = false;
        } else if (nextUrl) {
          json = await client.requestByUrl<any>(nextUrl);
        } else {
          break;
        }
        const items = (json.value ?? []) as any[];
        for (const it of items) {
          const cont = await push(mapItem(it));
          if (!cont) {
            const cookie = (json["@odata.nextLink"] || json["@odata.deltaLink"] || null) as string | null;
            return { cookie };
          }
        }
        nextUrl = (json["@odata.nextLink"] || null) as string | null;
        if (!nextUrl) {
          const cookie = (json["@odata.deltaLink"] || null) as string | null;
          return { cookie };
        }
      }
      return { cookie: null as string | null };
    };

    switch (ocName) {
      case "User": {
        const { cookie } = await pageAndEmit(
            "/users",
            { $select: select, $filter: filterStr },
            (u: any) => toConnectorObject("User", u.id, u, "displayName")
        );
        return streaming
            ? ({ pagedResultsCookie: cookie, remainingPagedResults: -1 } as SearchResult)
            : ({ results: collect });
      }
      case "Group": {
        const { cookie } = await pageAndEmit(
            "/groups",
            { $select: select, $filter: filterStr },
            (g: any) => toConnectorObject("Group", g.id, g, "displayName")
        );
        return streaming ? ({ pagedResultsCookie: cookie, remainingPagedResults: -1 }) : ({ results: collect });
      }
      case "ServicePrincipal": {
        const { cookie } = await pageAndEmit(
            "/servicePrincipals",
            { $select: select, $filter: filterStr },
            (sp: any) => toConnectorObject("ServicePrincipal", sp.id, sp, "displayName")
        );
        return streaming ? ({ pagedResultsCookie: cookie, remainingPagedResults: -1 }) : ({ results: collect });
      }
      case "UserManagedIdentity": {
        const ff = filterStr
            ? `(${filterStr}) and servicePrincipalType eq 'ManagedIdentity'`
            : "servicePrincipalType eq 'ManagedIdentity'";
        const { cookie } = await pageAndEmit(
            "/servicePrincipals",
            { $select: select, $filter: ff },
            (sp: any) => toConnectorObject("UserManagedIdentity", sp.id, sp, "displayName")
        );
        return streaming ? ({ pagedResultsCookie: cookie, remainingPagedResults: -1 }) : ({ results: collect });
      }
      case "Role": {
        const { cookie } = await pageAndEmit(
            "/directoryRoles",
            { $select: select },
            (r: any) => toConnectorObject("Role", r.id, r, "displayName")
        );
        return streaming ? ({ pagedResultsCookie: cookie, remainingPagedResults: -1 }) : ({ results: collect });
      }
      case "ServicePlan": {
        const skus = await client.listSubscribedSkus();
        for (const sku of skus.value ?? []) {
          const obj = toConnectorObject(
              "ServicePlan",
              String(sku.skuId),
              { skuId: sku.skuId, skuPartNumber: sku.skuPartNumber, servicePlans: sku.servicePlans },
              "skuPartNumber"
          );
          const cont = await push(obj);
          if (!cont) break;
        }
        return streaming ? ({ pagedResultsCookie: null, remainingPagedResults: -1 }) : ({ results: collect });
      }
      case "Team": {
        const { cookie } = await pageAndEmit(
            "/groups",
            { $filter: "resourceProvisioningOptions/Any(x:x eq 'Team')" },
            (g: any) => toConnectorObject("Team", g.id, { id: g.id, displayName: g.displayName }, "displayName")
        );
        return streaming ? ({ pagedResultsCookie: cookie, remainingPagedResults: -1 }) : ({ results: collect });
      }
      case "Channel": {
        // Expect CMP(EQ, ["teamId"], "<TEAM_ID>")
        let teamId: string | undefined;
        if (
            filter &&
            typeof filter === "object" &&
            (filter as any).type === "CMP" &&
            Array.isArray((filter as any).path) &&
            (filter as any).path[0] === "teamId" &&
            (filter as any).op === "EQ"
        ) {
          teamId = String((filter as any).value);
        }
        if (!teamId) {
          return streaming ? ({ pagedResultsCookie: null, remainingPagedResults: -1 }) : ({ results: collect });
        }
        const chans = await client.listChannels(teamId, top);
        for (const c of (chans.value ?? [])) {
          const obj = toConnectorObject(
              "Channel",
              `${teamId}:${c.id}`,
              { id: c.id, teamId, displayName: c.displayName },
              "displayName"
          );
          const cont = await push(obj);
          if (!cont) break;
        }
        return streaming ? ({ pagedResultsCookie: null, remainingPagedResults: -1 }) : ({ results: collect });
      }
      default:
        throw new Error(`Unsupported objectClass ${objectClass}`);
    }
  }

  async function get(objectClass: string, uid: string, options?: OperationOptions): Promise<ConnectorObject | null> {
    const select = toSelect(options);
    switch (normalizeClass(objectClass)) {
      case "User": {
        const u = await client.getUser(uid, select);
        return u ? toConnectorObject("User", u.id, u, "displayName") : null;
      }
      case "Group": {
        const g = await client.getGroup(uid, select);
        return g ? toConnectorObject("Group", g.id, g, "displayName") : null;
      }
      case "ServicePrincipal": {
        const sp = await client.getServicePrincipal(uid, select);
        return sp ? toConnectorObject("ServicePrincipal", sp.id, sp, "displayName") : null;
      }
      case "UserManagedIdentity": {
        const sp = await client.getServicePrincipal(uid, select);
        if (!sp || sp.servicePrincipalType !== "ManagedIdentity") return null;
        return toConnectorObject("UserManagedIdentity", sp.id, sp, "displayName");
      }
      case "Role": {
        const r = await client.getDirectoryRole(uid, select);
        return r ? toConnectorObject("Role", r.id, r, "displayName") : null;
      }
      case "ServicePlan": {
        const skus = await client.listSubscribedSkus();
        const sku = (skus.value ?? []).find((s: any) => String(s.skuId) === uid);
        if (!sku) return null;
        return toConnectorObject(
            "ServicePlan",
            String(sku.skuId),
            { skuId: sku.skuId, skuPartNumber: sku.skuPartNumber, servicePlans: sku.servicePlans },
            "skuPartNumber"
        );
      }
      case "Team": {
        const t = await client.getTeam(uid);
        const attrs = t?.displayName ? t : { id: uid, displayName: t?.displayName ?? null };
        return t ? toConnectorObject("Team", uid, attrs, "displayName") : null;
      }
      case "Channel": {
        const [teamId, channelId] = uid.split(":");
        if (!teamId || !channelId) throw new Error("Channel uid must be 'teamId:channelId'");
        const c = await client.getChannel(teamId, channelId);
        return c
            ? toConnectorObject("Channel", uid, { id: c.id, teamId, displayName: c.displayName }, "displayName")
            : null;
      }
      default:
        throw new Error(`Unsupported objectClass ${objectClass}`);
    }
  }

  async function create(
      objectClass: string,
      attrs: Record<string, AttributeValue>,
      _options?: OperationOptions
  ): Promise<ConnectorObject> {
    switch (normalizeClass(objectClass)) {
      case "User": {
        const u = await client.createUser(attrs as any);
        return toConnectorObject("User", u.id, u, "displayName");
      }
      case "Group": {
        const g = await client.createGroup(attrs as any);
        return toConnectorObject("Group", g.id, g, "displayName");
      }
      case "ServicePrincipal": {
        const sp = await client.createServicePrincipal(attrs as any);
        return toConnectorObject("ServicePrincipal", sp.id, sp, "displayName");
      }
      default:
        throw new Error(`Create not supported for ${objectClass}`);
    }
  }

  async function update(
      objectClass: string,
      uid: string,
      attrs: Record<string, AttributeValue>,
      _options?: OperationOptions
  ): Promise<ConnectorObject> {
    switch (normalizeClass(objectClass)) {
      case "User": {
        await client.updateUser(uid, attrs as any);
        const u = await client.getUser(uid);
        return toConnectorObject("User", u.id, u, "displayName");
      }
      case "Group": {
        await client.updateGroup(uid, attrs as any);
        const g = await client.getGroup(uid);
        return toConnectorObject("Group", g.id, g, "displayName");
      }
      case "ServicePrincipal": {
        await client.updateServicePrincipal(uid, attrs as any);
        const sp = await client.getServicePrincipal(uid);
        return toConnectorObject("ServicePrincipal", sp.id, sp, "displayName");
      }
      default:
        throw new Error(`Update not supported for ${objectClass}`);
    }
  }

  async function del(objectClass: string, uid: string, _options?: OperationOptions): Promise<void> {
    switch (normalizeClass(objectClass)) {
      case "User": return client.deleteUser(uid);
      case "Group": return client.deleteGroup(uid);
      case "ServicePrincipal": return client.deleteServicePrincipal(uid);
      default: throw new Error(`Delete not supported for ${objectClass}`);
    }
  }

  // SyncOp using delta
  async function sync(
      objectClass: string,
      token: SyncToken | null,
      options?: OperationOptions
  ): Promise<{ token: SyncToken; changes: ConnectorObject[] }> {
    const ocName = normalizeClass(objectClass);
    const top = Math.min(Math.max(options?.pageSize ?? 50, 1), 200);
    const changes: ConnectorObject[] = [];

    const pageDelta = async (path: string, nextUrl?: string | null) => {
      let json: any;
      if (nextUrl) json = await client.requestByUrl<any>(nextUrl);
      else json = await client.request<any>("GET", path, { $top: top });
      const items = (json.value ?? []) as any[];
      for (const it of items) {
        if (it["@removed"]) {
          changes.push({
            objectClass: ocName,
            uid: it.id,
            name: undefined,
            attributes: { __DELETED__: true } as any,
          });
        } else {
          changes.push(toConnectorObject(ocName, it.id, it, "displayName"));
        }
      }
      const next = (json["@odata.nextLink"] || json["@odata.deltaLink"] || null) as string | null;
      return next;
    };

    switch (ocName) {
      case "User": {
        const next = await pageDelta("/users/delta", token?.value ?? null);
        return { token: { value: next || (token?.value ?? "") }, changes };
      }
      case "Group": {
        const next = await pageDelta("/groups/delta", token?.value ?? null);
        return { token: { value: next || (token?.value ?? "") }, changes };
      }
      default:
        throw new Error(`Sync not supported for ${objectClass}`);
    }
  }

  return {
    // inline async methods are fine
    async schema(): Promise<Schema> { return schemaObj(); },
    async test(): Promise<void> { await client.listUsers("id", 1); },

    // shorthands must NOT be prefixed with `async` (they already reference async fns)
    search,
    get,
    create,
    update,
    delete: del,
    sync,
  } satisfies ConnectorSpi;
}

function s(name: string, type: any, extra: any = {}) {
  return { name, type, ...extra };
}
function oc(name: string, nativeName: string, attributes: any[], supports: any) {
  return { name, nativeName, attributes, supports, idAttribute: "id", nameAttribute: "displayName" };
}
function normalizeClass(cls: string): string {
  if (cls === "__ACCOUNT__") return "User";
  if (cls === "__GROUP__") return "Group";
  return cls;
}
