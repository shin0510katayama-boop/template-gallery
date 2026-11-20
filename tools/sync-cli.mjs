// Read and write the app's sync data from a PC (replaces the template-data repo).
//
//   node tools/sync-cli.mjs pull  [--dir D]   download to D/templates.json (+ D/.base.json)
//   node tools/sync-cli.mjs push  [--dir D]   upload the edits made to D/templates.json
//   node tools/sync-cli.mjs seed  FILE        first upload only: store FILE as-is (server must be empty)
//
// Typical use: pull -> edit templates.json (by hand or with add-saved-inputs.mjs) -> push.
// push stamps the templates you changed (_mtime = now) and records deletions, the
// same way the app does, then merges with whatever the phone wrote meanwhile
// (per template, newer wins), so nothing has to be done by hand.
//
// D defaults to %USERPROFILE%\.template-sync\work. The 合言葉 is read from
// TEMPLATE_SYNC_SECRET or %USERPROFILE%\.template-sync\secret.txt; the server from
// TEMPLATE_SYNC_URL (default: production). Keep D out of any git repo: it holds
// the 一時保存, which contain people's names.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME_DIR = path.join(os.homedir(), ".template-sync");
const URL_ = process.env.TEMPLATE_SYNC_URL || "https://template-gallery-tan.vercel.app/api/sync";
const TOMBSTONE_TTL = 90 * 24 * 60 * 60 * 1000;

const [cmd, ...args] = process.argv.slice(2);
const di = args.indexOf("--dir");
const DIR = di >= 0 ? path.resolve(args[di + 1]) : path.join(HOME_DIR, "work");
const FILE = path.join(DIR, "templates.json");
const BASE = path.join(DIR, ".base.json");

function secret() {
  if (process.env.TEMPLATE_SYNC_SECRET) return process.env.TEMPLATE_SYNC_SECRET.trim();
  const f = path.join(HOME_DIR, "secret.txt");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  fail(`合言葉がありません: ${f} に書くか TEMPLATE_SYNC_SECRET を設定してください`);
}

function fail(msg) { console.error(msg); process.exit(1); }

async function api(method, body) {
  const res = await fetch(URL_, {
    method,
    headers: { Authorization: `Bearer ${secret()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) fail("合言葉が違います (401)");
  if (res.status === 503) fail("サーバー側の同期がまだ設定されていません (503)");
  if (!res.ok && res.status !== 409) fail(`HTTP ${res.status} ${JSON.stringify(json)}`);
  return { status: res.status, ...json };
}

const empty = () => ({ schema: 1, templates: [], deleted: {} });
const strip = (t) => JSON.stringify(t, (k, v) => (k === "_mtime" ? undefined : v));
const write = (f, obj) => fs.writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");
const normalize = (d) => ({ schema: 1, templates: d?.templates || [], deleted: d?.deleted || {} });

function merge(local, remote) {
  const now = Date.now();
  const deleted = {};
  for (const src of [local.deleted, remote.deleted]) {
    for (const [id, ts] of Object.entries(src)) if (now - ts < TOMBSTONE_TTL) deleted[id] = Math.max(deleted[id] || 0, ts);
  }
  const remoteById = new Map(remote.templates.map((t) => [t.id, t]));
  const localIds = new Set(local.templates.map((t) => t.id));
  const pick = (a, b) => (!b ? a : !a ? b : (b._mtime || 0) > (a._mtime || 0) ? b : a);
  const out = local.templates.map((t) => pick(t, remoteById.get(t.id)));
  for (const t of remote.templates) if (!localIds.has(t.id)) out.push(t);
  return { schema: 1, templates: out.filter((t) => !(deleted[t.id] >= (t._mtime || 0))), deleted };
}

async function pull() {
  const res = await api("GET");
  const data = normalize(res.data || empty());
  fs.mkdirSync(DIR, { recursive: true });
  write(FILE, data);
  write(BASE, { version: res.version || 0, data });
  console.log(`pulled version ${res.version || 0}: ${data.templates.length} templates -> ${FILE}`);
}

async function push() {
  if (!fs.existsSync(FILE) || !fs.existsSync(BASE)) fail("先に pull してください");
  const base = JSON.parse(fs.readFileSync(BASE, "utf8"));
  const local = normalize(JSON.parse(fs.readFileSync(FILE, "utf8")));

  // Stamp what changed since the pull, and record what was removed.
  const now = Date.now();
  const old = new Map(base.data.templates.map((t) => [t.id, t]));
  const changed = [];
  for (const t of local.templates) {
    const prev = old.get(t.id);
    if (!prev || strip(prev) !== strip(t)) { t._mtime = now; changed.push(t.title); }
    delete local.deleted[t.id];
  }
  const ids = new Set(local.templates.map((t) => t.id));
  const removed = [];
  for (const t of base.data.templates) if (!ids.has(t.id)) { local.deleted[t.id] = now; removed.push(t.title); }
  if (!changed.length && !removed.length) { console.log("no changes"); return; }

  let version = base.version;
  let data = local;
  for (let attempt = 0; attempt < 5; attempt++) {
    const put = await api("PUT", { baseVersion: version, data });
    if (put.status !== 409) {
      write(FILE, data);
      write(BASE, { version: put.version, data });
      console.log(`pushed version ${put.version}\nchanged: ${changed.join(", ") || "-"}\nremoved: ${removed.join(", ") || "-"}`);
      return;
    }
    // The phone wrote in between: merge with its copy and try again.
    const res = await api("GET");
    version = res.version || 0;
    data = merge(local, normalize(res.data || empty()));
  }
  fail("書き込みが混み合っています。少し待ってからやり直してください");
}

async function seed() {
  const src = args[0];
  if (!src || !fs.existsSync(src)) fail("seed には元のファイルを指定してください");
  const data = normalize(JSON.parse(fs.readFileSync(src, "utf8")));
  const put = await api("PUT", { baseVersion: 0, data });
  if (put.status === 409) fail(`サーバーにはもうデータがあります (version ${put.version})。seed は最初の1回だけです`);
  console.log(`seeded version ${put.version}: ${data.templates.length} templates`);
}

const commands = { pull, push, seed };
if (!commands[cmd]) fail("usage: node tools/sync-cli.mjs pull|push [--dir D] | seed FILE");
await commands[cmd]();
