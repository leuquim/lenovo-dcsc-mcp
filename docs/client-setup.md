# Client setup

This repository provides a local MCP server over stdio. Each client starts its
own Node.js process; there is no HTTP listener and no Lenovo or OpenAI API key to
configure. The process needs outbound HTTPS access to `dcsc.lenovo.com`.

The examples below use the private repository
`leuquim/lenovo-dcsc-mcp`. Ask the repository owner for access before cloning.

## Install and verify

Node.js 22 or newer and Git are required. Clone with either GitHub CLI or SSH:

```bash
gh repo clone leuquim/lenovo-dcsc-mcp
cd lenovo-dcsc-mcp

# Or: git clone git@github.com:leuquim/lenovo-dcsc-mcp.git

npm ci
npm run build
npm run smoke:stdio
```

`smoke:stdio` starts the compiled server, performs an MCP handshake, lists its
tools, calls `dcsc_health`, and exits. It does not need a Lenovo login. Run it
again after pulling updates:

```bash
git pull --ff-only
npm ci
npm run build
npm run smoke:stdio
```

The client launch command consists of two absolute paths:

```text
/absolute/path/to/node /absolute/path/to/lenovo-dcsc-mcp/dist/mcp/server.js
```

Find the first path with `command -v node` on macOS/Linux or `where.exe node`
on Windows. Use the full path because desktop applications often inherit a
smaller `PATH` than an interactive shell. The second path must point to the
compiled file, so rebuild after changing or updating the source.

## Keep each client state separate

Sessions persist by default. Do not run two server processes against the same
session file: they do not coordinate writes across processes. Give Claude Code,
Claude Desktop, Codex, and any other client their own absolute locations:

```text
DCSC_SESSION_FILE=/absolute/path/to/state/claude-code-sessions.json
DCSC_ARTIFACT_DIR=/absolute/path/to/state/claude-code-artifacts
```

The sample configurations under `examples/client-configs/` already show this
pattern. Replace every `/absolute/path/to/...` value and create the parent state
directory before use. Session files may contain complete configurations and
exports may contain commercial design details, so store them in an appropriate
private location.

Without overrides, Linux/macOS session state is stored under the XDG state
directory (normally `~/.local/state/lenovo-dcsc/sessions.json`) and exports under
the XDG data directory (normally `~/.local/share/lenovo-dcsc/artifacts`). These
shared defaults are convenient for one client process only.

## Claude Code

From the cloned repository, register a user-scoped server with absolute paths:

```bash
mkdir -p "$HOME/.local/state/lenovo-dcsc/claude-code" \
  "$HOME/.local/share/lenovo-dcsc/claude-code"

claude mcp add --scope user --transport stdio lenovo-dcsc \
  --env DCSC_SESSION_FILE="$HOME/.local/state/lenovo-dcsc/claude-code/sessions.json" \
  --env DCSC_ARTIFACT_DIR="$HOME/.local/share/lenovo-dcsc/claude-code" \
  -- "$(command -v node)" "$PWD/dist/mcp/server.js"

claude mcp get lenovo-dcsc
```

Inside Claude Code, run `/mcp` to confirm that the server is connected. The
default scope is `local`, tied to the current project. `--scope user` makes the
server available in all of your projects. For a configuration that colleagues
can approve in a consuming repository, copy
`examples/client-configs/claude-code.mcp.json` to that repository as `.mcp.json`
and replace its absolute paths.

Claude Code documents the `--` separator as the boundary between its own
options and the stdio launch command. The command above follows the syntax
reported by the installed `claude mcp add --help` and the
[Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

## Claude Desktop

This repository is distributed as source rather than an `.mcpb` desktop
extension. Build it first, then merge the `lenovo-dcsc` entry from
`examples/client-configs/claude-desktop.json` into the `mcpServers` object in
Claude Desktop's developer configuration. Replace the Node, repository, state,
and artifact paths with absolute paths.

On macOS the configuration file is normally:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

On Windows it is normally:

```text
%APPDATA%\Claude\claude_desktop_config.json
```

Use Developer settings in Claude Desktop to open the active configuration when
available. Fully quit and reopen Claude Desktop after saving. Then check the
Connectors or Developer settings view for `lenovo-dcsc` and its tools. Current
Claude Desktop also supports installing a privately distributed `.mcpb`; this
repository does not currently publish one. See Anthropic's
[local MCP server guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
and the MCP project's
[local-host configuration reference](https://py.sdk.modelcontextprotocol.io/get-started/real-host/).

## Codex CLI, IDE extension, and ChatGPT desktop

From the cloned repository, add the local stdio server:

```bash
mkdir -p "$HOME/.local/state/lenovo-dcsc/codex" \
  "$HOME/.local/share/lenovo-dcsc/codex"

codex mcp add lenovo-dcsc \
  --env DCSC_SESSION_FILE="$HOME/.local/state/lenovo-dcsc/codex/sessions.json" \
  --env DCSC_ARTIFACT_DIR="$HOME/.local/share/lenovo-dcsc/codex" \
  -- "$(command -v node)" "$PWD/dist/mcp/server.js"

codex mcp get lenovo-dcsc
codex mcp list
```

Codex CLI and its IDE extension share `~/.codex/config.toml`. A project-scoped
`.codex/config.toml` also works in a trusted project. For longer DCSC operations,
the supplied `examples/client-configs/codex-config.toml` raises the per-tool
timeout to 15 minutes; copy and merge that table if needed. In Codex or the
ChatGPT desktop app, use `/mcp` to inspect connected servers.

The CLI form above and the TOML fields are verified against the installed
`codex mcp add --help` and the current
[official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).
Local stdio configuration is not used by ChatGPT web; web use requires a hosted
MCP/plugin deployment, which this repository does not provide.

## Runtime configuration

The server reads JSON from `DCSC_CONFIG`, or from
`~/.config/lenovo-dcsc/config.json` when that variable is unset. `DCSC_*`
environment variables override the JSON file. See
`examples/client-configs/dcsc-config.json` for a safe starting point.

The most useful overrides are:

| Variable | Purpose |
|---|---|
| `DCSC_SESSION_FILE` | Absolute per-process session snapshot path. |
| `DCSC_ARTIFACT_DIR` | Absolute directory for exported XML/workbook artifacts. |
| `DCSC_PERSIST_SESSIONS` | Set `false` for an intentionally stateless client. |
| `DCSC_LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error`, or `silent`; logs use stderr. |
| `DCSC_ARTIFACT_TTL_DAYS` | Retention period for completed MCP-owned exports; default 30. |
| `DCSC_COUNTRY`, `DCSC_GEO`, `DCSC_LANGUAGE`, `DCSC_CURRENCY` | Locale tuple; set all four together. |

The default locale is US/NA/en/USD. Do not change only one field: DCSC expects a
coherent locale tuple and can return HTTP 500 for mismatches. Never enable
`DCSC_LOG_RAW_ERRORS` in shared or routine use because it writes unredacted
upstream error bodies to stderr.

## First use and operating limits

Start with a read-only request such as:

> Check Lenovo DCSC health, then find current products matching "SR630 V3".

The client should call `dcsc_health` and `dcsc_find_products`. A typical design
flow is `dcsc_find_products` → `dcsc_launch` → `dcsc_list_options` →
`dcsc_get_feature` → `dcsc_configure` → `dcsc_validate` → `dcsc_export`.

Prices are anonymous Lenovo list prices for the selected country and currency;
they are not quotes, partner pricing, or bid pricing. The server drives an
undocumented DCSC web API, so upstream behavior can change. It backs off on WAF
responses and limits concurrency and request counts instead of trying to evade
Lenovo controls.

Known parity limits are tracked in the main README and `.docs/roadmaps/`. The
largest current gap is a populated native storage connection graph and managed
storage cable-part editing. GB300 power/cooling remains unknown when DCSC does
not return a power report. Account saves and authenticated commercial pricing
are outside the anonymous workflow.

## Troubleshooting

- `Connection closed` or no tools: run `npm run build` and
  `npm run smoke:stdio`, then verify both configured paths are absolute and
  exist. Check the client MCP logs; server logs are on stderr.
- Server starts in a terminal but not a desktop app: configure the absolute
  Node executable rather than `node`, and fully restart the desktop app.
- `Invalid DCSC configuration`: inspect the named field, the configured JSON,
  and any `DCSC_*` overrides. Environment variables take precedence.
- Missing prior sessions: confirm that this client still points to its original
  `DCSC_SESSION_FILE`. Do not merge session files by hand.
- Long operation times out in Codex: use the supplied TOML example with
  `tool_timeout_sec = 900`. DCSC exports can legitimately take several minutes.
- HTTP 499, 502, 503, or 504: let the server's breaker/backoff recover. Avoid
  launching parallel live tests or several clients against DCSC at once.
