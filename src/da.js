// Minimal read-only DirectAdmin API client.
//
// DirectAdmin exposes two API surfaces:
//   - legacy  /CMD_API_*  -> querystring output, or JSON when `json=yes` is sent
//   - modern  /api/*      -> always JSON (DA 1.6x+)
// Both authenticate with HTTP Basic using `username:login_key`.

export class DirectAdminError extends Error {
  constructor(message, { status, details } = {}) {
    super(message);
    this.name = "DirectAdminError";
    this.status = status;
    this.details = details;
  }
}

// DA's legacy format is a querystring, but repeated keys and `list[]=` style
// arrays both show up, so collapse duplicates into arrays rather than losing them.
function parseQuerystring(body) {
  const out = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const key = rawKey.replace(/\[\]$/, "");
    const isList = rawKey.endsWith("[]");
    if (key in out) {
      out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    } else {
      out[key] = isList ? [value] : value;
    }
  }
  return out;
}

function looksLikeJson(text) {
  const t = text.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

export class DirectAdminClient {
  constructor({ url, user, key, insecure = false, timeoutMs = 30000 }) {
    if (!url) throw new Error("DA_URL is not set");
    if (!user) throw new Error("DA_USER is not set");
    if (!key) throw new Error("DA_KEY is not set");
    this.baseUrl = url.replace(/\/+$/, "");
    this.user = user;
    this.key = key;
    this.timeoutMs = timeoutMs;
    this.insecure = insecure;
  }

  // Domain-scoped commands are answered from the perspective of the logged-in
  // account, so an admin asking about a user's domain gets "does not belong to
  // you" -- a `user=` parameter does not help. DirectAdmin's login-as syntax
  // puts the target account in the Basic auth username: `admin|username`.
  authHeader(as) {
    const identity = as ? `${this.user}|${as}` : this.user;
    return "Basic " + Buffer.from(`${identity}:${this.key}`).toString("base64");
  }

  async get(path, params = {}, { as } = {}) {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : "/" + path));
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    // Ask legacy commands for JSON; harmless on /api/* routes.
    if (path.includes("CMD_API_") && !url.searchParams.has("json")) {
      url.searchParams.set("json", "yes");
    }

    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: this.authHeader(as), Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    // A redirect to the login page means the credentials or the key's command
    // allowlist were rejected -- DA does not return 401 for legacy endpoints.
    if (res.status >= 300 && res.status < 400) {
      throw new DirectAdminError(
        "Authentication failed or this command is not permitted by the login key " +
          `(HTTP ${res.status} -> ${res.headers.get("location")})`,
        { status: res.status },
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new DirectAdminError(`Unauthorized (HTTP ${res.status})`, { status: res.status });
    }

    const body = await res.text();
    const data = looksLikeJson(body) ? JSON.parse(body) : parseQuerystring(body);

    // Legacy commands report failure in the payload, not the status code.
    if (data && !Array.isArray(data) && (data.error === "1" || data.error === 1)) {
      throw new DirectAdminError(data.text || "DirectAdmin returned an error", {
        status: res.status,
        details: data.details,
      });
    }
    if (!res.ok) {
      throw new DirectAdminError(`HTTP ${res.status}: ${body.slice(0, 300)}`, { status: res.status });
    }
    return data;
  }
}

// DA reports "unlimited" limits as the literal string, and numbers as MB.
export function toLimit(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "" || s === "unlimited") return Infinity;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function pct(used, limit) {
  const u = Number(used);
  if (!Number.isFinite(u) || limit === null) return null;
  if (limit === Infinity) return 0;
  if (limit === 0) return null;
  return Math.round((u / limit) * 1000) / 10;
}

export function fmtLimit(limit) {
  if (limit === null) return "?";
  return limit === Infinity ? "unlimited" : String(limit);
}

// Run `worker` over `items` with a bounded number of in-flight requests so a
// server with hundreds of users does not open hundreds of sockets at once.
export async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
