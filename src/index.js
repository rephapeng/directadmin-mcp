#!/usr/bin/env node
// Read-only MCP server for DirectAdmin. Every tool issues GET requests only;
// nothing here can create, modify, suspend or delete anything on the server.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DirectAdminClient, mapPool, toLimit, pct, fmtLimit } from "./da.js";

if (process.env.DA_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// Built lazily so the server still starts (and lists its tools) when the
// credentials are missing -- the error then surfaces on the first tool call.
let client = null;
function daClient() {
  if (!client) {
    client = new DirectAdminClient({
      url: process.env.DA_URL,
      user: process.env.DA_USER,
      key: process.env.DA_KEY,
    });
  }
  return client;
}
const da = { get: (path, params, opts) => daClient().get(path, params, opts) };

const server = new McpServer({ name: "directadmin", version: "0.1.0" });

const text = (value) => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
});

// Wrap a handler so DirectAdmin failures surface as tool errors the model can
// read, instead of crashing the stdio transport.
function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return await handler(args ?? {});
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `DirectAdmin request failed: ${err.message}` }],
      };
    }
  });
}

// DA returns user lists either as {list:[...]} or as a bare array depending on
// version and whether json=yes was honoured.
function asList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.list)) return data.list;
  if (data && typeof data === "object") return Object.values(data).flat();
  return [];
}

// CMD_API_DOMAIN_OWNERS returns the whole domain -> username map in one request,
// which is how the domain-scoped tools find out who to log in as. Cached briefly
// so a burst of per-domain questions does not refetch it every time.
const OWNERS_TTL_MS = 5 * 60 * 1000;
let ownersCache = null;
async function domainOwners(now = Date.now()) {
  if (!ownersCache || now - ownersCache.at > OWNERS_TTL_MS) {
    ownersCache = { at: now, map: await da.get("/CMD_API_DOMAIN_OWNERS") };
  }
  return ownersCache.map;
}

// Domain-scoped commands answer as the logged-in account, so an admin must log
// in as the owner. Resolve that owner unless the caller named one explicitly.
async function ownerOf(domain, explicit) {
  if (explicit) return explicit;
  const owners = await domainOwners();
  const owner = owners?.[domain] ?? owners?.[domain.toLowerCase()];
  if (!owner) {
    throw new Error(
      `No account on this server owns "${domain}". Check the spelling, or pass ` +
        "`user` explicitly if the domain is a subdomain or pointer.",
    );
  }
  return owner;
}

tool(
  "da_version",
  {
    title: "DirectAdmin version",
    description:
      "Show the DirectAdmin version and license info for the connected server. Use this first to confirm credentials work.",
    inputSchema: {},
  },
  async () => text(await da.get("/api/version")),
);

tool(
  "da_session",
  {
    title: "Current session",
    description:
      "Show which DirectAdmin account the API key belongs to and its privilege level (admin, reseller or user).",
    inputSchema: {},
  },
  async () => text(await da.get("/api/session")),
);

tool(
  "da_list_users",
  {
    title: "List users",
    description: "List every hosting user account on the server (admin/reseller level).",
    inputSchema: {},
  },
  async () => {
    const users = asList(await da.get("/CMD_API_SHOW_ALL_USERS"));
    return text({ count: users.length, users });
  },
);

tool(
  "da_list_resellers",
  { title: "List resellers", description: "List reseller accounts (admin level).", inputSchema: {} },
  async () => {
    const list = asList(await da.get("/CMD_API_SHOW_RESELLERS"));
    return text({ count: list.length, resellers: list });
  },
);

tool(
  "da_list_admins",
  { title: "List admins", description: "List admin accounts (admin level).", inputSchema: {} },
  async () => {
    const list = asList(await da.get("/CMD_API_SHOW_ADMINS"));
    return text({ count: list.length, admins: list });
  },
);

tool(
  "da_user_config",
  {
    title: "User config and limits",
    description:
      "Show one user's account settings and resource LIMITS: package, disk quota, bandwidth limit, allowed domains/emails/databases, suspension status.",
    inputSchema: { user: z.string().describe("DirectAdmin username") },
  },
  async ({ user }) => text(await da.get("/CMD_API_SHOW_USER_CONFIG", { user })),
);

tool(
  "da_user_usage",
  {
    title: "User resource usage",
    description:
      "Show one user's current resource USAGE: disk used, bandwidth used this month, inodes, and counts of domains, email accounts and databases.",
    inputSchema: { user: z.string().describe("DirectAdmin username") },
  },
  async ({ user }) => text(await da.get("/CMD_API_SHOW_USER_USAGE", { user })),
);

tool(
  "da_user_domains",
  {
    title: "User domains",
    description: "List the domains owned by one user, with per-domain bandwidth and quota.",
    inputSchema: { user: z.string().describe("DirectAdmin username") },
  },
  async ({ user }) => text(await da.get("/CMD_API_SHOW_USER_DOMAINS", { user })),
);

tool(
  "da_domain_owner",
  {
    title: "Domain owner lookup",
    description:
      "Find which DirectAdmin account owns a domain. Without `domain`, returns the whole domain -> user map for the server.",
    inputSchema: {
      domain: z.string().optional().describe("Domain name to look up; omit to list every domain"),
    },
  },
  async ({ domain }) => {
    const owners = await domainOwners();
    if (!domain) {
      return text({ count: Object.keys(owners).length, owners });
    }
    const owner = owners[domain] ?? owners[domain.toLowerCase()] ?? null;
    return text({ domain, owner, found: owner !== null });
  },
);

tool(
  "da_usage_report",
  {
    title: "Server-wide usage report",
    description:
      "Resource usage across ALL users, as a table sorted by highest disk usage. Combines each user's usage with their limits to give a percentage. Use `over` to show only accounts above a threshold, e.g. over=85 to find accounts close to their quota.",
    inputSchema: {
      over: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Only include users whose disk OR bandwidth usage is at least this percent"),
      limit: z.number().int().min(1).max(1000).optional().describe("Max rows to return (default 50)"),
      sort_by: z.enum(["disk", "bandwidth"]).optional().describe("Sort key, default disk"),
    },
  },
  async ({ over, limit = 50, sort_by = "disk" }) => {
    const users = asList(await da.get("/CMD_API_SHOW_ALL_USERS"));
    if (users.length === 0) return text("No users returned by DirectAdmin.");

    const results = await mapPool(users, 6, async (user) => {
      const [usage, config] = await Promise.all([
        da.get("/CMD_API_SHOW_USER_USAGE", { user }),
        da.get("/CMD_API_SHOW_USER_CONFIG", { user }),
      ]);
      const diskLimit = toLimit(config.quota);
      const bwLimit = toLimit(config.bandwidth);
      return {
        user,
        package: config.package ?? "",
        suspended: String(config.suspended ?? "no").toLowerCase() === "yes",
        disk_used_mb: Number(usage.quota) || 0,
        disk_limit: fmtLimit(diskLimit),
        disk_pct: pct(usage.quota, diskLimit),
        bw_used_mb: Number(usage.bandwidth) || 0,
        bw_limit: fmtLimit(bwLimit),
        bw_pct: pct(usage.bandwidth, bwLimit),
      };
    });

    const rows = results.filter((r) => r.ok).map((r) => r.value);
    const failed = results
      .map((r, i) => (r.ok ? null : { user: users[i], error: r.error.message }))
      .filter(Boolean);

    const filtered =
      over === undefined
        ? rows
        : rows.filter((r) => (r.disk_pct ?? 0) >= over || (r.bw_pct ?? 0) >= over);

    const key = sort_by === "bandwidth" ? "bw_pct" : "disk_pct";
    filtered.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));

    return text({
      total_users: users.length,
      matched: filtered.length,
      shown: Math.min(filtered.length, limit),
      threshold: over ?? null,
      users: filtered.slice(0, limit),
      ...(failed.length ? { failed } : {}),
    });
  },
);

tool(
  "da_dns",
  {
    title: "DNS records",
    description:
      "Show the DNS zone records for a domain. The owning account is looked up automatically.",
    inputSchema: {
      domain: z.string().describe("Domain name, e.g. example.com"),
      user: z.string().optional().describe("Owning username; looked up automatically if omitted"),
    },
  },
  async ({ domain, user }) => {
    const as = await ownerOf(domain, user);
    return text({ owner: as, ...(await da.get("/CMD_API_DNS_CONTROL", { domain }, { as })) });
  },
);

tool(
  "da_email_accounts",
  {
    title: "Email accounts",
    description:
      "List email accounts for a domain. The owning account is looked up automatically.",
    inputSchema: {
      domain: z.string().describe("Domain name"),
      user: z.string().optional().describe("Owning username; looked up automatically if omitted"),
    },
  },
  async ({ domain, user }) => {
    const as = await ownerOf(domain, user);
    const accounts = asList(await da.get("/CMD_API_POP", { domain, action: "list" }, { as }));
    return text({ owner: as, domain, count: accounts.length, accounts });
  },
);

tool(
  "da_email_forwarders",
  {
    title: "Email forwarders",
    description:
      "List email forwarders for a domain. The owning account is looked up automatically.",
    inputSchema: {
      domain: z.string().describe("Domain name"),
      user: z.string().optional().describe("Owning username; looked up automatically if omitted"),
    },
  },
  async ({ domain, user }) => {
    const as = await ownerOf(domain, user);
    const forwarders = await da.get("/CMD_API_EMAIL_FORWARDERS", { domain }, { as });
    return text({ owner: as, domain, forwarders });
  },
);

tool(
  "da_databases",
  {
    title: "MySQL databases",
    description:
      "List MySQL databases owned by a user. Without `user`, lists databases for the authenticated account (an admin usually owns none).",
    inputSchema: { user: z.string().optional().describe("List this user's databases (admin/reseller)") },
  },
  async ({ user }) => {
    const dbs = asList(await da.get("/CMD_API_DATABASES", { action: "list" }, { as: user }));
    return text({ owner: user ?? process.env.DA_USER, count: dbs.length, databases: dbs });
  },
);

tool(
  "da_packages",
  {
    title: "Hosting packages",
    description:
      "List hosting packages. User packages belong to whoever created them, so an admin sees none of their own -- pass `user` (a reseller name) to list that reseller's user packages. Reseller packages are always included at admin level.",
    inputSchema: {
      user: z.string().optional().describe("List the user packages owned by this reseller/admin"),
    },
  },
  async ({ user }) => {
    const userPackages = asList(await da.get("/CMD_API_PACKAGES_USER", {}, { as: user }));
    const out = { owner: user ?? process.env.DA_USER, user_packages: userPackages };
    if (!user) {
      try {
        out.reseller_packages = asList(await da.get("/CMD_API_PACKAGES_RESELLER"));
      } catch {
        // Reseller packages are admin-only; absent is not an error worth failing on.
      }
      if (userPackages.length === 0) {
        out.note =
          "This account owns no user packages. Pass user=<reseller> to see a reseller's packages; " +
          "da_list_resellers lists the resellers.";
      }
    }
    return text(out);
  },
);

// The service-monitor endpoint moved between DA releases, so try the known
// spellings and report clearly rather than silently returning nothing.
tool(
  "da_services",
  {
    title: "Service status",
    description:
      "Show the running state of server services (httpd, mysqld, dovecot, exim, named, etc). Admin level.",
    inputSchema: {},
  },
  async () => {
    const candidates = ["/api/services", "/CMD_API_SRV_MON", "/CMD_API_SHOW_SERVICES"];
    const errors = [];
    for (const path of candidates) {
      try {
        const services = await da.get(path);
        // Some builds answer 200 with an empty body instead of refusing, which
        // would otherwise look like "no services running".
        const empty = !services || Object.keys(services).length === 0;
        if (empty) {
          errors.push(`${path}: responded but returned no services`);
          continue;
        }
        return text({ endpoint: path, services });
      } catch (err) {
        errors.push(`${path}: ${err.message}`);
      }
    }
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            "No service-status endpoint returned data on this DirectAdmin version. " +
            "Service monitoring may only be available in the panel UI here. Tried:\n" +
            errors.join("\n"),
        },
      ],
    };
  },
);

tool(
  "da_get",
  {
    title: "Raw read-only API call",
    description:
      "Escape hatch for DirectAdmin endpoints this server does not wrap yet. Issues a GET to any /api/* or /CMD_API_* path. Read-only: requests that look like they modify state are refused.",
    inputSchema: {
      path: z.string().describe("API path, e.g. /CMD_API_SHOW_USER_CONFIG or /api/version"),
      params: z.record(z.string()).optional().describe("Query parameters"),
      as: z
        .string()
        .optional()
        .describe("Run the call as this user (DirectAdmin login-as), for domain-scoped commands"),
    },
  },
  async ({ path, params = {}, as }) => {
    if (!/^\/?(api\/|CMD_API_)/i.test(path.replace(/^\//, ""))) {
      throw new Error("path must start with /api/ or /CMD_API_");
    }
    const mutating = /^(create|delete|remove|modify|edit|add|suspend|unsuspend|reset|set|rename|move|kill|restart)$/i;
    const action = params.action ?? "";
    if (action && mutating.test(action)) {
      throw new Error(`refusing action=${action}: this server is read-only`);
    }
    return text(await da.get(path, params, { as }));
  },
);

await server.connect(new StdioServerTransport());
