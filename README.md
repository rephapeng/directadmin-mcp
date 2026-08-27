# directadmin-mcp

Read-only MCP server for the DirectAdmin API. Built against
`https://vega.jetorbit.net:2222` (DirectAdmin with the Evolution skin, modern
JSON `/api/*` endpoints plus the legacy `CMD_API_*` commands).

Every tool issues `GET` requests only. Nothing here can create, modify,
suspend or delete anything on the server.

## Setup

```sh
npm install
cp .env.example .env      # then fill in DA_USER and DA_KEY
```

Credentials are HTTP Basic: `username:login_key`. Use a **login key**
(DirectAdmin panel -> Login Keys), never the account password. Restrict the key
to the commands listed below, and to your public IP if it is static.

Verify the credentials and see which endpoints your key is allowed to call:

```sh
set -a && . ./.env && set +a
npm run doctor
```

`doctor` probes each endpoint and prints `ok` or `FAIL` per path, so you can
tell a permissions problem apart from a version difference.

## Tools

| Tool | What it answers |
| --- | --- |
| `da_version` | DirectAdmin version and license |
| `da_session` | Which account the key belongs to, and its privilege level |
| `da_list_users` | Every hosting account on the server |
| `da_list_resellers` / `da_list_admins` | Reseller and admin accounts |
| `da_user_config` | One user's **limits**: package, quota, bandwidth cap, suspension |
| `da_user_usage` | One user's **usage**: disk, bandwidth, inodes, counts |
| `da_user_domains` | Domains owned by a user |
| `da_domain_owner` | Which account owns a domain (or the whole domain → user map) |
| `da_usage_report` | **Server-wide** usage table, sorted by fullest account |
| `da_dns` | DNS zone records for a domain |
| `da_email_accounts` / `da_email_forwarders` | Mailboxes and forwarders per domain |
| `da_databases` | MySQL databases |
| `da_packages` | Hosting packages (reseller packages, and a reseller's user packages) |
| `da_services` | Running state of httpd, mysqld, dovecot, exim, named |
| `da_get` | Raw GET to any `/api/*` or `/CMD_API_*` path not wrapped above |

### Domain-scoped tools and login-as

DirectAdmin answers `CMD_API_DNS_CONTROL`, `CMD_API_POP`,
`CMD_API_EMAIL_FORWARDERS` and `CMD_API_DATABASES` from the perspective of the
logged-in account. An admin asking about a customer's domain gets
`"Domain does not belong to you"`, and a `user=` query parameter does **not**
change that — the account has to be named in the Basic auth username using
DirectAdmin's login-as syntax, `admin|username`.

`da_dns`, `da_email_accounts` and `da_email_forwarders` handle this: they look
the owner up via `CMD_API_DOMAIN_OWNERS` (cached for 5 minutes) and log in as
them. Pass `user` explicitly to skip the lookup. `da_databases` and
`da_packages` take a `user` argument for the same reason, and `da_get` exposes
it as `as`.

This is still read-only — logging in as a user only changes whose data the
`GET` returns.

### Monitoring

`da_usage_report` is the monitoring entry point. It fans out across all users
(6 requests in flight at a time), pairs each user's usage against their limits,
and returns a percentage per account:

```
da_usage_report(over=85)              # accounts within 15% of a limit
da_usage_report(sort_by="bandwidth")  # by bandwidth instead of disk
```

MCP is pull-based, so this answers "what is the state right now". For recurring
checks, drive this tool from a scheduled agent or a cron job. Note that a
cloud-scheduled agent runs from a different IP, so it will not work with a
login key that is pinned to your home IP.

## Login key command allowlist

```
CMD_API_SHOW_ALL_USERS      CMD_API_SHOW_RESELLERS      CMD_API_SHOW_ADMINS
CMD_API_SHOW_USER_CONFIG    CMD_API_SHOW_USER_USAGE     CMD_API_SHOW_USER_DOMAINS
CMD_API_DNS_CONTROL         CMD_API_POP                 CMD_API_EMAIL_FORWARDERS
CMD_API_DATABASES           CMD_API_PACKAGES_USER       CMD_API_LICENSE
CMD_API_DOMAIN_OWNERS       CMD_API_PACKAGES_RESELLER
```

Login-as (`admin|user`) must also be permitted for the domain-scoped tools to
work at admin level; an account password always allows it.

A key that is missing a command does not get a `401` — DirectAdmin redirects to
the login page instead. This server reports that as an explicit
"not permitted by the login key" error rather than as a silent empty result.

## Register with Claude Code

```sh
claude mcp add directadmin \
  --env DA_URL=https://vega.jetorbit.net:2222 \
  --env DA_USER=your-admin-username \
  --env DA_KEY=your-login-key \
  -- node /Users/refanhar/Documents/jetorbit/repository/directadmin-mcp/src/index.js
```

## Endpoint compatibility

`da_services` uses endpoints whose paths have moved between DirectAdmin
releases; it tries each known spelling and reports what it attempted if none
respond. On **DA 1.708 (verified against vega)** none of them return data:
`/api/services` and `/CMD_API_SRV_MON` redirect to the login page and
`/CMD_API_SHOW_SERVICES` answers `200` with an empty body, so `da_services`
reports an error rather than an empty service list. Service monitoring appears
to be panel-UI only on this build.

If `doctor` shows a `FAIL` for an endpoint you need, `da_get` can reach it
directly once you know the correct path.
