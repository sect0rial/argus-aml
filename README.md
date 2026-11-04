# argus-aml

Add the [Argus API](https://daertho.com/founders/)'s compliance tools to your AI agent: sanctions and PEP screening,
adverse media, face checks, document reviews, safeguarding reconciliation, e-signatures and financial-crime typologies,
as MCP tools.

```bash
npx argus-aml init
```

It starts you on a sandbox key. Sandbox results are invented, cost nothing, and need no account.

## What this script does

Exactly this, and nothing else:

1. **One request** to `POST https://argus.unbackoffice.com/v1/founder/sandbox-key` to create a sandbox key.
   No account, no email, no personal data. Skipped when you pass `--key` or a key is already saved.
2. **Writes one file**, `~/.config/argus/key`, with mode 600 so only you can read it.
3. **Adds the Argus server** to the agents it finds on this machine, and only those:

   | Agent      | How it's detected          | What is touched                                     |
   | ---------- | -------------------------- | --------------------------------------------------- |
   | Claude Code | `claude` CLI on your PATH | `claude mcp add --scope user argus …`               |
   | Cursor     | `~/.cursor/` exists        | `argus` entry in `~/.cursor/mcp.json`               |
   | Codex      | `~/.codex/` exists         | `[mcp_servers.argus]` in `~/.codex/config.toml`     |
   | Windsurf   | `~/.codeium/windsurf/`     | `argus` entry in `~/.codeium/windsurf/mcp_config.json` |
   | Gemini CLI | `~/.gemini/` exists        | `argus` entry in `~/.gemini/settings.json`          |

   Only the `argus` entry is written; the rest of each file is left as it was. A config file that isn't valid JSON is
   left alone and reported.

It sends nothing else anywhere and collects no telemetry. The whole script is [`bin/init.js`](bin/init.js), about
200 lines with no dependencies. To see what it would do on your machine before it does it:

```bash
npx argus-aml init --print
```

## Going live

When Daertho issues your live key, run the same command with it:

```bash
npx argus-aml init --key ak_your_live_key
```

Same URL, same tools. The only change is that results stop carrying `"sandbox": true`. Running `init` again later
keeps the saved key: it never swaps a live key for a sandbox one.

## Any other MCP client

Point it at `https://argus.unbackoffice.com/mcp` and send your key in the `X-API-Key` header. The Claude desktop app
adds remote servers through its own Connectors settings rather than a config file, so this script can't set it up;
use the URL there.

## Plain HTTP

```bash
curl https://argus.unbackoffice.com/v1/screen \
  -H "X-API-Key: $(cat ~/.config/argus/key)" \
  -H "Content-Type: application/json" \
  -d '{"name": "Sandbox Sanctioned"}'
```

API reference: https://argus.unbackoffice.com/developers/reference

## Licence

The installer in this package is MIT licensed. The Argus API it connects to is a Daertho service under its own terms.
