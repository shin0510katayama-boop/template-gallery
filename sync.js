// ---- GitHub同期 ----
// localStorage stays the working copy (the app keeps working offline); a private
// GitHub repo holds a shared copy so the same data can be read and edited from
// elsewhere. Merging is per template: whichever side touched it last (_mtime)
// wins, and deletions are remembered as tombstones so they do not come back.
//
// Loaded after app.js, so it shares that script's globals (templates, render,
// STORAGE_KEY, autoSavePendingId, showToast).

const SYNC_KEY = "templateCopier.sync.v1";
const SYNC_DEFAULT_REPO = "shin0510katayama-boop/template-data";
const SYNC_PATH = "templates.json";
const TOMBSTONE_TTL = 90 * 24 * 60 * 60 * 1000;

const TemplateSync = (() => {
  /** @type {{token:string,repo:string,sha:string|null,deleted:Object<string,number>,dirty:boolean,lastSyncedAt:number|null,lastError:string|null}} */
  let state = loadState();
  /** id -> JSON of the template as last written, to spot which ones changed. */
  let snapshot = new Map();
  let syncing = false;
  let again = false;
  let saveSeq = 0;
  let pushTimer = null;
  let retryTimer = null;
  const listeners = new Set();

  function loadState() {
    const base = { token: "", repo: SYNC_DEFAULT_REPO, sha: null, deleted: {}, dirty: false, lastSyncedAt: null, lastError: null };
    try {
      return { ...base, ...JSON.parse(localStorage.getItem(SYNC_KEY) || "{}") };
    } catch {
      return base;
    }
  }

  function saveState() {
    localStorage.setItem(SYNC_KEY, JSON.stringify(state));
    listeners.forEach((fn) => fn());
  }

  function contentKey(t) {
    return JSON.stringify(t, (k, v) => (k === "_mtime" ? undefined : v));
  }

  function takeSnapshot() {
    snapshot = new Map(templates.map((t) => [t.id, contentKey(t)]));
  }

  /** Called from saveTemplates() before it writes: stamp what changed, remember what went. */
  function stamp() {
    const now = Date.now();
    const seen = new Set();
    for (const t of templates) {
      seen.add(t.id);
      const key = contentKey(t);
      if (snapshot.get(t.id) !== key || typeof t._mtime !== "number") t._mtime = now;
      snapshot.set(t.id, key);
    }
    for (const id of [...snapshot.keys()]) {
      if (!seen.has(id)) {
        state.deleted[id] = now;
        snapshot.delete(id);
      }
    }
  }

  /** Called from saveTemplates() after it writes. */
  function afterSave() {
    saveSeq++;
    state.dirty = true;
    saveState();
    if (!state.token) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; sync(); }, 1500);
  }

  // Replacing `templates` under an open dialog, a pending auto-save or a focused
  // input would throw away what is being typed, so wait for a quiet moment.
  function busy() {
    if (document.querySelector("dialog[open]")) return true;
    if (typeof autoSavePendingId !== "undefined" && autoSavePendingId) return true;
    const el = document.activeElement;
    if (!el || !el.matches("input, textarea, select")) return false;
    // Focus can linger on an input inside a dialog that has already closed.
    const box = el.closest("dialog");
    return !box || box.open;
  }

  function retryLater() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; sync(); }, 3000);
  }

  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function api(method, body) {
    const res = await fetch(`https://api.github.com/repos/${state.repo}/contents/${SYNC_PATH}`, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${state.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === "GET") return null;
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function normalize(data) {
    const list = Array.isArray(data) ? data : Array.isArray(data?.templates) ? data.templates : [];
    return {
      templates: list.map((t) => {
        const m = migrateTemplate(t);
        if (typeof m._mtime !== "number") m._mtime = m.updatedAt || m.createdAt || 0;
        return m;
      }),
      deleted: data && typeof data.deleted === "object" && !Array.isArray(data.deleted) ? data.deleted : {},
    };
  }

  function merge(local, remote) {
    const now = Date.now();
    const deleted = {};
    for (const src of [local.deleted, remote.deleted]) {
      for (const [id, ts] of Object.entries(src)) {
        if (now - ts < TOMBSTONE_TTL) deleted[id] = Math.max(deleted[id] || 0, ts);
      }
    }
    const remoteById = new Map(remote.templates.map((t) => [t.id, t]));
    const localIds = new Set(local.templates.map((t) => t.id));
    const out = [];
    const pick = (a, b) => (!b ? a : !a ? b : (b._mtime || 0) > (a._mtime || 0) ? b : a);
    for (const t of local.templates) out.push(pick(t, remoteById.get(t.id)));
    for (const t of remote.templates) if (!localIds.has(t.id)) out.push(t);
    return {
      templates: out.filter((t) => !(deleted[t.id] >= (t._mtime || 0))),
      deleted,
    };
  }

  function serialize(data) {
    return JSON.stringify({ schema: 1, templates: data.templates, deleted: data.deleted }, null, 2) + "\n";
  }

  function describeError(e) {
    if (e.status === 401) return "トークンが無効です";
    if (e.status === 403 || e.status === 404) return "リポジトリに書き込めません（トークンの権限を確認）";
    if (!navigator.onLine) return "オフラインです";
    return `同期に失敗しました（${e.message}）`;
  }

  async function sync() {
    if (!state.token) return;
    if (syncing) { again = true; return; }
    if (busy()) { retryLater(); return; }
    syncing = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const seqAtStart = saveSeq;
        const res = await api("GET");
        const remoteSha = res ? res.sha : null;
        if (res && remoteSha === state.sha && !state.dirty) break;

        const remote = res ? normalize(JSON.parse(b64decode(res.content))) : { templates: [], deleted: {} };
        if (saveSeq !== seqAtStart || busy()) { again = true; break; }
        const merged = merge({ templates, deleted: state.deleted }, remote);

        if (JSON.stringify(merged.templates) !== JSON.stringify(templates)) {
          templates = merged.templates;
          takeSnapshot();
          localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
          render();
        }
        state.deleted = merged.deleted;

        const body = serialize(merged);
        let newSha = remoteSha;
        if (!res || serialize(remote) !== body) {
          try {
            const put = await api("PUT", {
              message: `sync from app ${new Date().toISOString()}`,
              content: b64encode(body),
              ...(remoteSha ? { sha: remoteSha } : {}),
            });
            newSha = put.content.sha;
          } catch (e) {
            // Someone else wrote in between: start over from their version.
            if (e.status === 409 || e.status === 422) continue;
            throw e;
          }
        }
        state.sha = newSha;
        if (saveSeq === seqAtStart) state.dirty = false;
        else again = true;
        state.lastSyncedAt = Date.now();
        state.lastError = null;
        break;
      }
    } catch (e) {
      state.lastError = describeError(e);
    } finally {
      syncing = false;
      saveState();
      if (again) { again = false; setTimeout(sync, 500); }
    }
  }

  function configure(token, repo) {
    const changedTarget = repo !== state.repo || token !== state.token;
    state.token = token;
    state.repo = repo || SYNC_DEFAULT_REPO;
    // A new target has never seen our data, so treat everything local as unsent.
    if (changedTarget) { state.sha = null; state.dirty = true; }
    state.lastError = null;
    saveState();
    return sync();
  }

  function disconnect() {
    state.token = "";
    state.sha = null;
    state.lastError = null;
    saveState();
  }

  // Older data has no _mtime yet; fall back to its own timestamps so an edit made
  // elsewhere is not outranked by a template that merely got stamped on upgrade.
  for (const t of templates) {
    if (typeof t._mtime !== "number") t._mtime = t.updatedAt || t.createdAt || 0;
  }
  takeSnapshot();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync();
  });
  window.addEventListener("online", () => sync());
  if (state.token) sync();

  return {
    stamp,
    afterSave,
    sync,
    configure,
    disconnect,
    get state() { return state; },
    get syncing() { return syncing; },
    onChange(fn) { listeners.add(fn); },
  };
})();

// ---- 同期ダイアログ ----
(() => {
  const btn = document.getElementById("btn-sync");
  const dialog = document.getElementById("sync-dialog");
  const form = document.getElementById("sync-form");
  const tokenField = document.getElementById("sync-token");
  const repoField = document.getElementById("sync-repo");
  const status = document.getElementById("sync-status");
  const btnDisconnect = document.getElementById("btn-sync-disconnect");

  function statusText() {
    const s = TemplateSync.state;
    if (!s.token) return "未設定（この端末の中だけに保存されています）";
    if (TemplateSync.syncing) return "同期中…";
    if (s.lastError) return s.lastError;
    if (s.lastSyncedAt) {
      const d = new Date(s.lastSyncedAt);
      return `同期済み（${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}）`;
    }
    return "未同期";
  }

  function refresh() {
    const s = TemplateSync.state;
    btn.dataset.state = !s.token ? "off" : s.lastError ? "error" : "on";
    status.textContent = statusText();
    btnDisconnect.hidden = !s.token;
  }

  btn.addEventListener("click", () => {
    const s = TemplateSync.state;
    tokenField.value = s.token;
    repoField.value = s.repo;
    refresh();
    dialog.showModal();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = tokenField.value.trim();
    if (!token) { showToast("トークンを入力してください"); return; }
    dialog.close();
    await TemplateSync.configure(token, repoField.value.trim());
    const err = TemplateSync.state.lastError;
    showToast(err || "同期しました");
  });

  document.getElementById("btn-sync-cancel").addEventListener("click", () => dialog.close());
  btnDisconnect.addEventListener("click", () => {
    if (!confirm("この端末の同期を解除しますか?\nこの端末のデータは消えません。")) return;
    TemplateSync.disconnect();
    dialog.close();
    showToast("同期を解除しました");
  });

  TemplateSync.onChange(refresh);
  refresh();
})();
