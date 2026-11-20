#!/usr/bin/env node
"use strict";
// npx argus-aml init: get a sandbox key (or take yours) and add the Argus MCP server to the agents on this machine.
//
// Everything this script does, and nothing else:
//   1. POST https://argus.unbackoffice.com/v1/founder/sandbox-key, only when no key is given or already saved
//   2. write ~/.config/argus/key, readable only by you
//   3. add the Argus server to the agents it finds on this machine:
//        Claude Code   `claude mcp add` (needs the Claude Code CLI on PATH)
//        Cursor        ~/.cursor/mcp.json
//        Codex         ~/.codex/config.toml
//        Windsurf      ~/.codeium/windsurf/mcp_config.json
//        Gemini CLI    ~/.gemini/settings.json
// It sends nothing else anywhere and collects no telemetry. `--print` shows these steps without doing them.
//
// Your own key: `--key-stdin` asks for it without showing it (or reads it from a pipe), and ARGUS_API_KEY in the
// environment works too. `--key ak_...` still works, but it leaves the key in your shell history.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ok = (s) => console.log("✓ " + s);
const warn = (s) => console.error("! " + s);
const fail = (s) => { console.error("✗ " + s); process.exit(1); };
const mask = (key) => (key ? key.slice(0, 6) + "…" : "");

const DEFAULT_API = "https://argus.unbackoffice.com";

// The key is sent to this URL and the URL is written into the agent configs. Anything other than the default must
// be https (http on this machine only) and confirmed with ARGUS_ALLOW_CUSTOM_URL=1.
function apiBase() {
  const raw = (process.env.ARGUS_API_URL || "").trim();
  if (!raw) return DEFAULT_API;
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    fail("ARGUS_API_URL is not a valid URL. Unset it to use " + DEFAULT_API + ".");
  }
  const plain = !u.username && !u.password && !u.search && !u.hash;
  const url = (u.origin + u.pathname).replace(/\/+$/, "");
  if (plain && url === DEFAULT_API) return DEFAULT_API;
  if (!plain) fail("ARGUS_API_URL must be a plain base URL, with no credentials, query or fragment.");
  const local = u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !local) fail("ARGUS_API_URL must be an https URL (http is accepted for localhost only).");
  if (process.env.ARGUS_ALLOW_CUSTOM_URL !== "1") {
    fail("ARGUS_API_URL points at " + u.host + ". Your key would be sent there and that address written into your " +
      "agent configs. Set ARGUS_ALLOW_CUSTOM_URL=1 if that is intended, or unset ARGUS_API_URL.");
  }
  return url;
}

const API = apiBase();
const MCP = API + "/mcp";
const HOME = os.homedir();
const KEY_FILE = path.join(HOME, ".config", "argus", "key");

// A key goes into an HTTP header, JSON and TOML: printable ASCII only, no spaces, quotes or backslashes.
const validKey = (key) => /^[\x21\x23-\x5b\x5d-\x7e]{8,256}$/.test(key);

// Read a key from standard input: hidden prompt in a terminal, otherwise whatever is piped in.
function readKey() {
  const stdin = process.stdin;
  return new Promise((resolve) => {
    let typed = "";
    stdin.setEncoding("utf8");
    if (!stdin.isTTY) {
      stdin.on("data", (c) => { typed += c; });
      stdin.on("end", () => resolve(typed.trim()));
      return;
    }
    process.stderr.write("API key (hidden): ");
    stdin.setRawMode(true);
    stdin.resume();
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") { done(); return resolve(typed.trim()); }
        if (ch === "\u0003") { done(); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// Write a file that only its owner can read. The permissions are set before any content is written, also when
// the file already existed with wider ones.
function writePrivate(file, text) {
  const fd = fs.openSync(file, "w", 0o600);
  try {
    try { fs.fchmodSync(fd, 0o600); } catch (e) { /* not supported on this platform */ }
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

function argValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return "";
  if (!args[i + 1]) fail(name + " needs a value");
  return args[i + 1];
}

async function sandboxKey() {
  let r;
  try {
    r = await fetch(API + "/v1/founder/sandbox-key", { method: "POST" });
  } catch (e) {
    fail("Couldn't reach " + API + ". Check your connection and try again.");
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.api_key) fail(d.detail || "Couldn't create a sandbox key. Try again shortly.");
  if (!validKey(String(d.api_key))) fail("The server's reply didn't contain a usable key. Try again shortly.");
  return String(d.api_key);
}

function savedKey() {
  try {
    return fs.readFileSync(KEY_FILE, "utf8").trim();
  } catch (e) {
    return "";
  }
}

function saveKey(key) {
  const dir = path.dirname(KEY_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (e) { /* not supported on this platform */ }
  writePrivate(KEY_FILE, key + "\n");
  return KEY_FILE;
}

function onPath(cmd) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
}

// Replace or add the "argus" entry under mcpServers in a JSON config file. A file that isn't valid JSON is left alone.
function writeJsonEntry(file, entry) {
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.error("✗ Left " + file + " alone: it isn't valid JSON.");
      return false;
    }
  }
  cfg.mcpServers = { ...(cfg.mcpServers || {}), argus: entry };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writePrivate(file, JSON.stringify(cfg, null, 2) + "\n");
  return true;
}

// Replace or add the [mcp_servers.argus] table in a TOML file, without touching anything else in it.
function writeTomlTable(file, lines) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const block = "[mcp_servers.argus]\n" + lines.join("\n") + "\n";
  const re = /^\[mcp_servers\.argus\]\n(?:(?!\[)[^\n]*\n?)*/m;
  if (re.test(text)) text = text.replace(re, (m, at) => block + (at + m.length < text.length ? "\n" : ""));
  else text = text.replace(/\s*$/, "") + (text.trim() ? "\n\n" : "") + block;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writePrivate(file, text);
  return true;
}

// Each agent: how it's detected, what gets touched, and how to add the server.
const AGENTS = [
  {
    name: "Claude Code",
    found: () => onPath("claude"),
    touches: "`claude mcp add --scope user argus` (your Claude Code user config)",
    add(key) {
      spawnSync("claude", ["mcp", "remove", "argus", "--scope", "user"], { stdio: "ignore" });
      const r = spawnSync("claude", ["mcp", "add", "--transport", "http", "--scope", "user", "argus", MCP,
        "--header", "X-API-Key: " + key], { encoding: "utf8" });
      if (r.status !== 0) {
        console.error("✗ Couldn't add Argus to Claude Code: " + ((r.stderr || "").split(key).join("***").trim() || "unknown error"));
        return false;
      }
      return true;
    },
  },
  {
    name: "Cursor",
    file: path.join(HOME, ".cursor", "mcp.json"),
    found() { return fs.existsSync(path.dirname(this.file)); },
    add(key) { return writeJsonEntry(this.file, { url: MCP, headers: { "X-API-Key": key } }); },
  },
  {
    name: "Codex",
    file: path.join(HOME, ".codex", "config.toml"),
    found() { return fs.existsSync(path.dirname(this.file)); },
    add(key) {
      // JSON.stringify gives a valid TOML basic string for these values
      return writeTomlTable(this.file, ["url = " + JSON.stringify(MCP), 'http_headers = { "X-API-Key" = ' + JSON.stringify(key) + " }"]);
    },
  },
  {
    name: "Windsurf",
    file: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"),
    found() { return fs.existsSync(path.dirname(this.file)); },
    add(key) { return writeJsonEntry(this.file, { serverUrl: MCP, headers: { "X-API-Key": key } }); },
  },
  {
    name: "Gemini CLI",
    file: path.join(HOME, ".gemini", "settings.json"),
    found() { return fs.existsSync(path.dirname(this.file)); },
    add(key) { return writeJsonEntry(this.file, { httpUrl: MCP, headers: { "X-API-Key": key } }); },
  },
];

function manualInstructions(file) {
  console.log("\nAdd this to any MCP client:");
  console.log("  URL:    " + MCP);
  console.log("  Header: X-API-Key: " + (file ? "(the key in " + file + ")" : "your key"));
}

function printPlan(given) {
  console.log("argus-aml init would do this, and nothing else:\n");
  if (given) console.log("  1. Use the key you gave (" + mask(given) + "); no request is made to create one");
  else console.log("  1. POST " + API + "/v1/founder/sandbox-key to create a sandbox key (no account, no personal data)");
  console.log("  2. Write " + KEY_FILE + " (mode 600: readable only by you)");
  console.log("  3. Add the server " + MCP + " with header X-API-Key to the agents found on this machine:");
  let any = false;
  for (const a of AGENTS) {
    const here = a.found();
    any = any || here;
    console.log("       " + (here ? "found    " : "not found") + "  " + a.name + "  →  " + (a.touches || a.file));
  }
  if (!any) console.log("       (none found: it would print the URL and header for you to add by hand)");
  console.log("\nNothing else is sent or stored. Run without --print to do it.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "init") {
    console.log("Usage: npx argus-aml init [--key-stdin] [--print]");
    console.log("  --key-stdin   use a key you already have (your live key, after Daertho issues one): asks for it");
    console.log("                without showing it, or reads it from a pipe");
    console.log("  ARGUS_API_KEY in the environment is used the same way");
    console.log("  --key ak_...  still works, but leaves the key in your shell history");
    console.log("  --print       show what init would do on this machine without doing it");
    process.exit(args.length && !["-h", "--help"].includes(args[0]) ? 1 : 0);
  }
  // a key saved by an earlier run is kept: running init again must never swap a live key for a sandbox one
  const fromArg = argValue(args, "--key");
  const fromStdin = args.includes("--key-stdin");
  if (fromArg && fromStdin) fail("Use --key-stdin or --key, not both.");
  if (fromArg) {
    warn("--key leaves your key in your shell history, and other programs on this machine can see it while this runs.");
    warn("Next time use --key-stdin, or set ARGUS_API_KEY in the environment.");
  }
  const typed = fromStdin ? await readKey() : "";
  if (fromStdin && !typed) fail("No key was read from standard input.");
  const given = typed || fromArg || process.env.ARGUS_API_KEY || savedKey();
  if (given && !validKey(given)) {
    fail("That isn't a usable API key: it must be 8 to 256 printable characters with no spaces, quotes or backslashes." +
      (typed || fromArg || process.env.ARGUS_API_KEY ? "" : " It was read from " + KEY_FILE + "; delete that file and run this again."));
  }
  if (args.includes("--print")) return printPlan(given);

  const key = given || (await sandboxKey());
  ok(given ? "Using your API key (" + mask(key) + ")" : "Sandbox key created");
  const file = saveKey(key);
  ok("Key saved to " + file);

  const added = [];
  for (const a of AGENTS) if (a.found() && a.add(key)) added.push(a.name);
  if (added.length) {
    ok("Argus tools added to " + added.join(", "));
    manualInstructions(file);
    console.log("\nRestart your agent, then try:");
  } else {
    console.log("\nNo supported agent found on this machine.");
    if (!onPath("claude")) {
      console.log("  The Claude Code CLI isn't on your PATH (the Claude desktop app alone can't be set up by this script).");
      console.log("  Install it with: npm install -g @anthropic-ai/claude-code   then run this again.");
    }
    manualInstructions(file);
    console.log("\nThen try:");
  }
  console.log("  Screen Sandbox Sanctioned and tell me what happens next.");
  if (!given) console.log("\nSandbox results are invented. Ask for a live key at " + API + "/developers");
}

main().catch((e) => fail("Something went wrong: " + (e && e.message ? e.message : e)));
