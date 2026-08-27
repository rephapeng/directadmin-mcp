#!/usr/bin/env node
// Connectivity check: verifies credentials and reports which DirectAdmin
// endpoints this server/login key actually allows. Run before wiring up MCP.

import { DirectAdminClient } from "./da.js";

if (process.env.DA_INSECURE_TLS === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const missing = ["DA_URL", "DA_USER", "DA_KEY"].filter((v) => !process.env[v]);
if (missing.length) {
  console.error(`Missing env: ${missing.join(", ")}`);
  console.error("Set them in .env and run:  set -a && . ./.env && set +a && npm run doctor");
  process.exit(1);
}

const da = new DirectAdminClient({
  url: process.env.DA_URL,
  user: process.env.DA_USER,
  key: process.env.DA_KEY,
});

const probes = [
  ["/api/version", {}],
  ["/api/session", {}],
  ["/CMD_API_SHOW_ALL_USERS", {}],
  ["/CMD_API_SHOW_RESELLERS", {}],
  ["/CMD_API_SHOW_ADMINS", {}],
  ["/CMD_API_PACKAGES_USER", {}],
  ["/CMD_API_PACKAGES_RESELLER", {}],
  ["/CMD_API_DOMAIN_OWNERS", {}],
  ["/api/services", {}],
  ["/CMD_API_SRV_MON", {}],
];

console.log(`Server : ${process.env.DA_URL}`);
console.log(`User   : ${process.env.DA_USER}\n`);

let firstUser = null;
for (const [path, params] of probes) {
  try {
    const data = await da.get(path, params);
    const preview = JSON.stringify(data).slice(0, 160);
    console.log(`  ok   ${path}\n       ${preview}`);
    if (path === "/CMD_API_SHOW_ALL_USERS" && !firstUser) {
      const list = Array.isArray(data) ? data : (data.list ?? Object.values(data).flat());
      firstUser = list[0] ?? null;
    }
  } catch (err) {
    console.log(`  FAIL ${path}\n       ${err.message}`);
  }
}

// Per-user endpoints need a real username, so only probe once we have one.
if (firstUser) {
  console.log(`\nPer-user probes (using "${firstUser}"):`);
  for (const path of ["/CMD_API_SHOW_USER_CONFIG", "/CMD_API_SHOW_USER_USAGE", "/CMD_API_SHOW_USER_DOMAINS"]) {
    try {
      const data = await da.get(path, { user: firstUser });
      console.log(`  ok   ${path}\n       keys: ${Object.keys(data).join(", ").slice(0, 200)}`);
    } catch (err) {
      console.log(`  FAIL ${path}\n       ${err.message}`);
    }
  }
} else {
  console.log("\nNo users listed, so per-user endpoints were not probed.");
}
