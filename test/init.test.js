"use strict";
// Checks for bin/init.js. Every run gets its own empty HOME and a PATH without the Claude Code CLI, is always given
// a made-up key, and so never calls the API or touches a real agent config.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const INIT = path.join(__dirname, "..", "bin", "init.js");
const KEY = "ak_made_up_key_for_tests_0123456789";
const posix = process.platform !== "win32";
const mode = (file) => fs.statSync(file).mode & 0o777;

const made = [];
process.on("exit", () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function home(...dirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argus-aml-test-"));
  made.push(dir);
  for (const d of dirs) fs.mkdirSync(path.join(dir, d), { recursive: true });
  return dir;
}

function run(dir, args, { env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [INIT, ...args], {
    encoding: "utf8",
    input: input === undefined ? "" : input,
    env: { PATH: "/usr/bin:/bin", HOME: dir, USERPROFILE: dir, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

const keyFile = (dir) => path.join(dir, ".config", "argus", "key");

test("--print with no key: shows the plan, writes nothing", () => {
  const dir = home(".cursor");
  const r = run(dir, ["init", "--print"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /would do this, and nothing else/);
  assert.match(r.out, /\n {7}found {6}Cursor/);
  assert.equal(fs.existsSync(keyFile(dir)), false);
  assert.equal(fs.existsSync(path.join(dir, ".cursor", "mcp.json")), false);
});

test("a key from the environment: saved owner-only, added to the agents found, never printed in full", () => {
  const dir = home(".cursor", ".codex");
  fs.writeFileSync(path.join(dir, ".codex", "config.toml"), 'model = "x"\n');
  const r = run(dir, ["init"], { env: { ARGUS_API_KEY: KEY } });
  assert.equal(r.code, 0, r.all);
  assert.equal(r.err, "");
  assert.equal(r.all.includes(KEY), false);
  assert.equal(fs.readFileSync(keyFile(dir), "utf8"), KEY + "\n");
  const cursor = JSON.parse(fs.readFileSync(path.join(dir, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(cursor.mcpServers.argus, { url: "https://argus.unbackoffice.com/mcp", headers: { "X-API-Key": KEY } });
  const toml = fs.readFileSync(path.join(dir, ".codex", "config.toml"), "utf8");
  assert.equal(toml, 'model = "x"\n\n[mcp_servers.argus]\nurl = "https://argus.unbackoffice.com/mcp"\nhttp_headers = { "X-API-Key" = "' + KEY + '" }\n');
  if (posix) {
    assert.equal(mode(keyFile(dir)), 0o600);
    assert.equal(mode(path.dirname(keyFile(dir))), 0o700);
    assert.equal(mode(path.join(dir, ".cursor", "mcp.json")), 0o600);
    assert.equal(mode(path.join(dir, ".codex", "config.toml")), 0o600);
  }
});

test("--key-stdin reads the key from a pipe, with no warning", () => {
  const dir = home();
  const r = run(dir, ["init", "--key-stdin"], { input: KEY + "\n" });
  assert.equal(r.code, 0, r.all);
  assert.equal(r.err, "");
  assert.equal(fs.readFileSync(keyFile(dir), "utf8"), KEY + "\n");
  assert.equal(run(home(), ["init", "--key-stdin"], { input: "" }).code, 1);
});

test("--key still works and warns", () => {
  const dir = home();
  const r = run(dir, ["init", "--key", KEY]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /shell history/);
  assert.equal(r.all.includes(KEY), false);
  assert.equal(fs.readFileSync(keyFile(dir), "utf8"), KEY + "\n");
  assert.equal(run(home(), ["init", "--key", KEY, "--key-stdin"], { input: KEY }).code, 1);
});

test("a key file that was readable by others is made owner-only", { skip: !posix }, () => {
  const dir = home(".config/argus");
  fs.writeFileSync(keyFile(dir), "old\n", { mode: 0o644 });
  fs.chmodSync(keyFile(dir), 0o644);
  fs.chmodSync(path.dirname(keyFile(dir)), 0o755);
  const r = run(dir, ["init"], { env: { ARGUS_API_KEY: KEY } });
  assert.equal(r.code, 0, r.all);
  assert.equal(mode(keyFile(dir)), 0o600);
  assert.equal(mode(path.dirname(keyFile(dir))), 0o700);
});

test("a saved key is kept on the next run", () => {
  const dir = home();
  assert.equal(run(dir, ["init"], { env: { ARGUS_API_KEY: KEY } }).code, 0);
  const r = run(dir, ["init"]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /Using your API key/);
  assert.equal(fs.readFileSync(keyFile(dir), "utf8"), KEY + "\n");
});

test("a key with quotes, spaces or line breaks is refused and nothing is written", () => {
  for (const bad of ['ak_"} \nurl = "https://example.com', "ak_with space_0123", "ak_back\\slash_0123", "short"]) {
    const dir = home(".codex");
    const r = run(dir, ["init"], { env: { ARGUS_API_KEY: bad } });
    assert.equal(r.code, 1, bad);
    assert.equal(fs.existsSync(keyFile(dir)), false);
    assert.equal(fs.existsSync(path.join(dir, ".codex", "config.toml")), false);
  }
});

test("another API address is refused unless it is https and explicitly allowed", () => {
  const no = run(home(), ["init", "--print"], { env: { ARGUS_API_URL: "https://api.example.com" } });
  assert.equal(no.code, 1);
  assert.match(no.err, /ARGUS_ALLOW_CUSTOM_URL=1/);
  const http = run(home(), ["init", "--print"], { env: { ARGUS_API_URL: "http://api.example.com", ARGUS_ALLOW_CUSTOM_URL: "1" } });
  assert.equal(http.code, 1);
  const yes = run(home(), ["init", "--print"], { env: { ARGUS_API_URL: "https://api.example.com/", ARGUS_ALLOW_CUSTOM_URL: "1" } });
  assert.equal(yes.code, 0);
  assert.match(yes.out, /https:\/\/api\.example\.com\/mcp/);
  const same = run(home(), ["init", "--print"], { env: { ARGUS_API_URL: "https://argus.unbackoffice.com/" } });
  assert.equal(same.code, 0);
});
