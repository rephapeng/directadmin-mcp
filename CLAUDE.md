# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A read-only MCP server (stdio transport) exposing the DirectAdmin hosting-panel
API as tools. Plain ESM Node, no build step, no test suite, no linter. Two
runtime dependencies: `@modelcontextprotocol/sdk` and `zod`.

## Commands

```sh
npm install
set -a && . ./.env && set +a   # src/* read credentials from the environment, not .env
npm run doctor                 # probe every endpoint, print ok/FAIL per path
npm start                      # run the MCP server on stdio (waits for a client)
```

`npm run doctor` (`src/doctor.js`) is the only way to exercise the code against a
real server — there are no tests. Run it after touching `src/da.js` or adding an
endpoint. Its per-path `ok`/`FAIL` output distinguishes a login-key permission
problem from a DirectAdmin version difference.

`npm start` alone proves nothing beyond "it parses" — the process just blocks on
stdio. To test a tool end-to-end, register the server with a client (see the
`claude mcp add` invocation in README.md) and call the tool.

Required env: `DA_URL`, `DA_USER`, `DA_KEY` (Basic auth, `username:login_key` —
a DirectAdmin **login key**, never a password). `DA_INSECURE_TLS=1` disables cert
verification process-wide; both entrypoints handle it identically.

## Architecture

- `src/da.js` — `DirectAdminClient` (one method: `get`), plus the numeric
  helpers `toLimit`/`pct`/`fmtLimit` and the `mapPool` bounded-concurrency runner.
- `src/index.js` — every tool definition and the stdio server. New tools go here.
- `src/doctor.js` — standalone probe script; shares the client, nothing else.

### DirectAdmin quirks the client absorbs

These are the reason `da.js` exists rather than raw `fetch` calls, and they are
easy to reintroduce when adding endpoints:

- **Two API surfaces.** Legacy `/CMD_API_*` returns querystring-encoded bodies;
  modern `/api/*` returns JSON. `get()` appends `json=yes` to legacy paths and
  sniffs the body, so callers always receive parsed objects. Repeated and
  `key[]=` querystring keys collapse into arrays.
- **Failure is not signalled by status code.** A legacy command the login key is
  not allowed to call returns a *302 to the login page*, not 401. `get()` uses
  `redirect: "manual"` and converts any 3xx into an explicit "not permitted by
  the login key" `DirectAdminError`. Legacy errors also arrive as `error=1` in a
  200 body. Never assume `res.ok` means success.
- **Shapes vary by version.** User lists come back as `{list:[...]}`, a bare
  array, or an object of arrays — `asList()` in `index.js` normalises all three.
  Limits are MB or the literal string `unlimited` (`toLimit` maps that to
  `Infinity`, which `pct` reports as 0%).
- **Paths move between releases.** `da_services` tries `/api/services`,
  `/CMD_API_SRV_MON`, `/CMD_API_SHOW_SERVICES` in turn and, if all fail *or all
  return empty*, returns an error listing what it attempted. Follow that pattern
  for other unstable endpoints rather than hard-coding one spelling. On the
  DA 1.708 target none of the three return data — a 200 with an empty body is
  treated as a failure, not as "no services running".
- **Domain-scoped commands need login-as.** `CMD_API_DNS_CONTROL`, `CMD_API_POP`,
  `CMD_API_EMAIL_FORWARDERS`, `CMD_API_DATABASES` and `CMD_API_PACKAGES_USER`
  answer as the logged-in account; an admin gets "does not belong to you" for a
  customer's domain, and a `user=` parameter does not fix it. The account goes in
  the Basic auth username instead: `admin|username`, which is what
  `client.get(path, params, { as })` builds. `ownerOf()` in `index.js` resolves
  the owner from the `CMD_API_DOMAIN_OWNERS` map (whole server in one request,
  cached 5 min). Any new per-domain or per-user tool needs this, not a `user=`
  param.

### Tool conventions

Register tools with the local `tool()` wrapper in `index.js`, not
`server.registerTool` directly — the wrapper catches `DirectAdminError` and
returns `isError` content so a failed request never kills the stdio transport.
Return values go through `text()`, which JSON-stringifies non-strings.

Tool `description` fields are the model's only documentation at call time; keep
them explicit about the distinction the API blurs — `SHOW_USER_CONFIG` is
**limits**, `SHOW_USER_USAGE` is **usage**.

### Read-only invariant

This is the project's defining constraint, stated in README.md and in both file
headers: every tool issues `GET` only. `da_get` is the escape hatch and enforces
it twice — the path must start with `/api/` or `/CMD_API_`, and an `action=`
parameter matching a mutating verb (`create|delete|modify|suspend|restart|…`) is
refused. Do not add a write tool, or relax those guards, without the user
explicitly asking for it.

### Fan-out

`da_usage_report` is the only tool that issues more than one request: it pairs
usage against config for every user via `mapPool(users, 6, …)`. Keep any new
fan-out bounded the same way — a server with hundreds of accounts must not open
hundreds of sockets. `mapPool` never rejects; it returns `{ok, value}` /
`{ok:false, error}` per item, and `da_usage_report` surfaces the failures in a
`failed` array alongside the results rather than dropping them.

## Login key allowlist

The key must be granted each `CMD_API_*` command the tools use (list in
README.md). Adding a tool on a new legacy command means the user has to widen
the key's allowlist in the DirectAdmin panel — mention it when you do.
