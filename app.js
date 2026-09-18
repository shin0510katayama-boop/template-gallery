const STORAGE_KEY = "templateCopier.templates.v1";
const BRACKET_RE = /【([^【】]*)】/g;
const FIELD_RE = /〔([^〔〕]*)〕/g;
const LEGACY_TOKEN_RE = /\{\{slot:[a-zA-Z0-9-]+\}\}/;

/** @typedef {{id:string,label:string,text:string}} Option */
/** @typedef {{id:string,label:string,options:Option[]}} Slot */
/** @typedef {{id:string,label:string,default:string}} Field */
/** @typedef {{id:string,name:string,group:string,values:Object<string,string>,selections:Object<string,string>,savedAt:number}} SavedInput */
/** @typedef {{id:string,title:string,category:string,body:string,slots:Slot[],fields:Field[],savedInputs:SavedInput[],createdAt:number,updatedAt:number}} Template */

/** @type {Template[]} */
let templates = loadTemplates();

/** Which option is currently selected per template+slot (transient, not persisted). Key: `${templateId}:${slotId}` -> optionId */
const selections = new Map();

/** What's currently typed into each free-input field (transient, not persisted). Key: `${templateId}:${fieldId}` -> text */
const fieldValues = new Map();

/** Which saved input a template is currently being edited against (transient). Key: templateId -> savedInputId */
const editingSavedInput = new Map();

/** Which saved-input groups are currently expanded on a card (transient, like the
 * selections above — folding everything shut again on reload is the calmer default).
 * Key: `${templateId}\n${groupName}` */
const openSavedGroups = new Set();

const grid = document.getElementById("template-grid");
const emptyState = document.getElementById("empty-state");
const searchInput = document.getElementById("search");
const categoryFilter = document.getElementById("category-filter");
const categoryList = document.getElementById("category-list");

const dialog = document.getElementById("template-dialog");
const form = document.getElementById("template-form");
const dialogTitle = document.getElementById("dialog-title");
const fieldId = document.getElementById("template-id");
const fieldTitle = document.getElementById("field-title");
const fieldCategory = document.getElementById("field-category");
const fieldBody = document.getElementById("field-body");
const btnMakeSlot = document.getElementById("btn-make-slot");
const slotsEditor = document.getElementById("slots-editor");
const slotsSection = document.getElementById("slots-section");
const slotsCount = document.getElementById("slots-count");
const btnMakeField = document.getElementById("btn-make-field");
const fieldsEditor = document.getElementById("fields-editor");
const fieldsSection = document.getElementById("fields-section");
const fieldsCount = document.getElementById("fields-count");
const insertExistingRow = document.getElementById("insert-existing-row");
const existingFieldSelect = document.getElementById("existing-field-select");
const btnInsertExistingField = document.getElementById("btn-insert-existing-field");
const bodyPreview = document.getElementById("body-preview");

const toast = document.getElementById("toast");

/** Maps a slot's id to the exact `【label】` text currently written into fieldBody, so a
 * label rename or slot removal can find-and-replace the right spot precisely. */
const slotBrackets = new Map();
/** Same idea as slotBrackets, but for `〔label〕` free-input field placeholders. */
const fieldBrackets = new Map();

function loadTemplates() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return parsed.map(migrateTemplate);
  } catch {
    return [];
  }
}

// Templates have gone through a few body formats over time:
//   1. a single `content` string
//   2. a `branches` array of full-body alternatives
//   3. `body` with `{{slot:ID}}` tokens + a `slots` array (previous version of this feature)
//   4. `body` with `【label】` placeholders + a `slots` array (current)
// Fold any older shape into the current one.
function migrateTemplate(t) {
  const fields = Array.isArray(t.fields) ? t.fields : [];
  // Older saves recorded only field values in a snapshot; add an empty branch-selections
  // map to any that predate that.
  const savedInputs = (Array.isArray(t.savedInputs) ? t.savedInputs : []).map((s) => ({
    ...s,
    selections: s.selections && typeof s.selections === "object" ? s.selections : {},
    // Saves made before grouping existed land in the unnamed ("未分類") group.
    group: typeof s.group === "string" ? s.group : "",
  }));

  if (typeof t.body === "string" && Array.isArray(t.slots)) {
    const withFields = { ...t, fields, savedInputs };
    return LEGACY_TOKEN_RE.test(t.body) ? convertLegacyTokens(t.body, t.slots, withFields) : withFields;
  }

  if (Array.isArray(t.branches)) {
    if (t.branches.length <= 1) {
      return { ...t, body: t.branches[0]?.content ?? "", slots: [], fields, savedInputs };
    }
    const label = "パターン";
    return {
      ...t,
      body: `【${label}】`,
      slots: [{
        id: uid(),
        label,
        options: t.branches.map((b) => ({ id: b.id || uid(), label: b.label || "", text: b.content })),
      }],
      fields,
      savedInputs,
    };
  }

  return { ...t, body: t.content ?? "", slots: [], fields, savedInputs };
}

function convertLegacyTokens(body, slots, t) {
  const used = new Set();
  let newBody = body;
  const newSlots = slots.map((s, i) => {
    const desired = (s.label || "").trim() || `分岐${i + 1}`;
    let label = desired;
    let n = 2;
    while (used.has(label)) { label = `${desired} (${n})`; n++; }
    used.add(label);
    newBody = newBody.split(`{{slot:${s.id}}}`).join(`【${label}】`);
    return { ...s, label };
  });
  return { ...t, body: newBody, slots: newSlots };
}

function saveTemplates() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  toast.style.animation = "none";
  void toast.offsetWidth;
  toast.style.animation = "";
  setTimeout(() => { toast.hidden = true; }, 1800);
}

function getCategories() {
  return [...new Set(templates.map((t) => t.category).filter(Boolean))].sort();
}

function renderCategoryOptions() {
  const categories = getCategories();
  const currentFilter = categoryFilter.value;

  categoryFilter.innerHTML = '<option value="">すべてのカテゴリ</option>' +
    categories.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
  categoryFilter.value = categories.includes(currentFilter) ? currentFilter : "";

  categoryList.innerHTML = categories.map((c) => `<option value="${escapeAttr(c)}"></option>`).join("");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

/** Grow a textarea to fit its content instead of showing a scrollbar.
 * Everything here is border-box, so the height has to include the borders too —
 * otherwise the content is a couple of pixels too tall for its own box and the
 * textarea silently becomes a scroll container that swallows page scrolls. */
function autoGrowTextarea(el) {
  el.style.height = "auto";
  const borders = el.offsetHeight - el.clientHeight;
  el.style.height = `${el.scrollHeight + borders}px`;
}

function formatSavedAt(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function optionLabel(o, i) { return o.label.trim() || `選択肢${i + 1}`; }
function slotLabel(s, i) { return s.label.trim() || `分岐${i + 1}`; }
function fieldLabel(f, i) { return f.label.trim() || `入力欄${i + 1}`; }

/** Order slots / fields the way they actually appear in the body text, so the
 * editor blocks and the card rows read top-to-bottom in the same order as the
 * sentence they belong to. Anything whose placeholder is no longer in the body
 * (a stale entry, or a label that is still blank) sinks to the end, keeping its
 * previous relative position. */
function sortByBodyOrder(items, body, bracketOf) {
  const LAST = Number.MAX_SAFE_INTEGER;
  return items
    .map((item, i) => {
      const bracket = bracketOf(item, i);
      const pos = bracket ? body.indexOf(bracket) : -1;
      return { item, i, pos: pos === -1 ? LAST : pos };
    })
    .sort((a, b) => (a.pos - b.pos) || (a.i - b.i))
    .map((x) => x.item);
}

function selectedOptionId(templateId, slot) {
  const key = `${templateId}:${slot.id}`;
  const chosen = selections.get(key);
  return slot.options.some((o) => o.id === chosen) ? chosen : slot.options[0]?.id;
}

/** Snapshot the currently-typed field values and chosen branch options for a template. */
function captureCurrentState(t) {
  const values = {};
  t.fields.forEach((f) => {
    values[f.id] = fieldValues.has(`${t.id}:${f.id}`) ? fieldValues.get(`${t.id}:${f.id}`) : f.default;
  });
  const branchSelections = {};
  t.slots.forEach((s) => {
    branchSelections[s.id] = selectedOptionId(t.id, s);
  });
  return { values, selections: branchSelections };
}

/** The saved input this template is currently being edited against, or null. */
function activeSavedInput(t) {
  const savedId = editingSavedInput.get(t.id);
  if (!savedId) return null;
  const snap = t.savedInputs.find((s) => s.id === savedId);
  if (!snap) {
    editingSavedInput.delete(t.id);
    return null;
  }
  return snap;
}

/** Write the card's current inputs straight into the saved input being edited (no explicit "overwrite" step). */
function persistActiveSavedInput(t) {
  const snap = activeSavedInput(t);
  if (!snap) return null;
  const { values, selections: branchSelections } = captureCurrentState(t);
  snap.values = values;
  snap.selections = branchSelections;
  snap.savedAt = Date.now();
  saveTemplates();
  return snap;
}

/** Drop everything typed / chosen on a card, so it falls back to the template's defaults. */
function clearLiveInputs(t) {
  t.fields.forEach((f) => fieldValues.delete(`${t.id}:${f.id}`));
  t.slots.forEach((s) => selections.delete(`${t.id}:${s.id}`));
}

/** Load a saved input's values and branch choices into the card's live inputs. */
function applySavedInput(t, snap) {
  t.fields.forEach((f) => {
    const v = snap.values[f.id];
    fieldValues.set(`${t.id}:${f.id}`, v !== undefined ? v : (f.default || ""));
  });
  t.slots.forEach((s) => {
    const optId = (snap.selections || {})[s.id];
    if (optId) selections.set(`${t.id}:${s.id}`, optId);
  });
}

// ---- 一時保存のグループ ----

function savedGroupOf(s) {
  return (s.group || "").trim();
}

function savedGroupKey(templateId, group) {
  return `${templateId}\n${group}`;
}

/** Every named group already in use on this template, for the save dialog's picker. */
function existingGroupNames(t) {
  const names = [];
  t.savedInputs.forEach((s) => {
    const g = savedGroupOf(s);
    if (g && !names.includes(g)) names.push(g);
  });
  return names.sort((a, b) => a.localeCompare(b, "ja"));
}

/** Saved inputs bucketed by group: `[[groupName, items], ...]`, newest first within
 * each group and newest-used group first. The unnamed group always sits last. */
function groupedSavedInputs(t) {
  const byGroup = new Map();
  [...t.savedInputs].sort((a, b) => b.savedAt - a.savedAt).forEach((s) => {
    const g = savedGroupOf(s);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(s);
  });
  const named = [...byGroup.entries()].filter(([g]) => g !== "");
  named.sort((a, b) => b[1][0].savedAt - a[1][0].savedAt);
  if (byGroup.has("")) named.push(["", byGroup.get("")]);
  return named;
}

/** Where a fresh save should go by default: the group being edited, else the group
 * the last save went into. The dialog shows it, so it is a suggestion, not a filing rule. */
function defaultGroupForNewSave(t) {
  const editing = activeSavedInput(t);
  if (editing) return savedGroupOf(editing);
  const newest = [...t.savedInputs].sort((a, b) => b.savedAt - a.savedAt)[0];
  return newest ? savedGroupOf(newest) : "";
}

// Typing should not hit localStorage on every keystroke, so edits to the active
// saved input are written back on a short debounce (and flushed on blur/unload).
let autoSaveTimer = null;
let autoSavePendingId = null;
let autoSaveCard = null;

function cancelAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  autoSavePendingId = null;
  autoSaveCard = null;
}

function flushAutoSave() {
  if (!autoSavePendingId) return;
  const t = templates.find((x) => x.id === autoSavePendingId);
  const card = autoSaveCard;
  cancelAutoSave();
  if (!t) return;
  const snap = persistActiveSavedInput(t);
  if (snap && card) {
    const dateEl = card.querySelector(".saved-input-item.editing .saved-input-date");
    if (dateEl) dateEl.textContent = formatSavedAt(snap.savedAt);
  }
}

function scheduleAutoSave(t, card) {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSavePendingId = t.id;
  autoSaveCard = card || null;
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    flushAutoSave();
  }, 400);
}

/** Replace every 【label】 placeholder in a body with an option's text, picked per-slot by `pickOption`. */
function resolveWithSlots(bodyStr, slotsArr, pickOption) {
  return bodyStr.replace(BRACKET_RE, (match, label) => {
    const slot = slotsArr.find((s) => (s.label || "").trim() === label.trim());
    if (!slot || slot.options.length === 0) return match;
    const opt = pickOption(slot);
    return opt ? opt.text : match;
  });
}

/** Replace every 〔label〕 placeholder in a body with whatever's currently typed for that field. */
function resolveWithFields(bodyStr, fieldsArr, templateId) {
  return bodyStr.replace(FIELD_RE, (match, label) => {
    const field = fieldsArr.find((f) => (f.label || "").trim() === label.trim());
    if (!field) return match;
    const key = `${templateId}:${field.id}`;
    return fieldValues.has(key) ? fieldValues.get(key) : (field.default || "");
  });
}

/** The text a saved input copies: resolved from its own stored values and branch
 * choices, not from whatever happens to be typed on the card right now. */
function resolveSavedBody(t, snap) {
  const withSlots = resolveWithSlots(t.body, t.slots, (slot) => {
    const optId = (snap.selections || {})[slot.id];
    // Same fallback as the card: an option that no longer exists means the first one.
    return slot.options.find((o) => o.id === optId) || slot.options[0];
  });
  return withSlots.replace(FIELD_RE, (match, label) => {
    const field = t.fields.find((f) => (f.label || "").trim() === label.trim());
    if (!field) return match;
    const v = (snap.values || {})[field.id];
    return v !== undefined ? v : (field.default || "");
  });
}

function resolveBody(t) {
  const withSlots = resolveWithSlots(t.body, t.slots, (slot) => {
    const optId = selectedOptionId(t.id, slot);
    return slot.options.find((o) => o.id === optId);
  });
  return resolveWithFields(withSlots, t.fields, t.id);
}

function render() {
  renderCategoryOptions();

  const query = searchInput.value.trim().toLowerCase();
  const category = categoryFilter.value;

  const matchesQuery = (t) => {
    if (!query) return true;
    if (t.title.toLowerCase().includes(query)) return true;
    if (resolveBody(t).toLowerCase().includes(query)) return true;
    if (t.slots.some((s) => s.options.some((o) => o.text.toLowerCase().includes(query) || o.label.toLowerCase().includes(query)))) return true;
    return t.fields.some((f) => f.label.toLowerCase().includes(query));
  };

  const filtered = templates
    .filter((t) => !category || t.category === category)
    .filter(matchesQuery)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  emptyState.hidden = templates.length > 0;
  grid.hidden = templates.length === 0;

  grid.innerHTML = filtered.map((t) => {
    // Resolve the display labels first (they depend on the stored index), then
    // lay the rows out in the order the placeholders appear in the body.
    const slotRows = sortByBodyOrder(
      t.slots.map((s, si) => ({ slot: s, name: slotLabel(s, si) })),
      t.body,
      (x) => `【${x.name}】`
    ).map(({ slot: s, name }) => {
      const activeId = selectedOptionId(t.id, s);
      const pills = s.options.map((o, oi) => `
        <button type="button" class="branch-tab ${o.id === activeId ? "active" : ""}" data-id="${t.id}" data-slot="${s.id}" data-option="${o.id}">${escapeHtml(optionLabel(o, oi))}</button>
      `).join("");
      return `<div class="branch-tabs"><span class="branch-tabs-label">${escapeHtml(name)}</span>${pills}</div>`;
    }).join("");

    const fieldRows = sortByBodyOrder(
      t.fields.map((f, fi) => ({ field: f, name: fieldLabel(f, fi) })),
      t.body,
      (x) => `〔${x.name}〕`
    ).map(({ field: f, name }) => {
      const key = `${t.id}:${f.id}`;
      const val = fieldValues.has(key) ? fieldValues.get(key) : f.default;
      return `<div class="field-row">
        <span class="field-row-label">${escapeHtml(name)}</span>
        <textarea class="field-input" rows="1" data-id="${t.id}" data-field="${f.id}" placeholder="入力してください">${escapeHtml(val)}</textarea>
      </div>`;
    }).join("");

    const hasSavableState = t.fields.length > 0 || t.slots.length > 0;
    const editingSnap = activeSavedInput(t);

    const savedItemHtml = (s) => {
      const isEditing = !!editingSnap && editingSnap.id === s.id;
      return `
        <li class="saved-input-item${isEditing ? " editing" : ""}">
          <span class="saved-input-name">${escapeHtml(s.name)}</span>
          ${isEditing ? `<span class="saved-input-badge">編集中</span>` : ""}
          <span class="saved-input-date">${formatSavedAt(s.savedAt)}</span>
          <div class="saved-input-actions">
            <button type="button" class="btn-copy-saved" data-id="${t.id}" data-saved-id="${escapeAttr(s.id)}">コピー</button>
            ${isEditing
              ? `<button type="button" class="btn-stop-editing" data-id="${t.id}">編集を終える</button>`
              : `<button type="button" class="btn-edit-saved" data-id="${t.id}" data-saved-id="${escapeAttr(s.id)}">編集</button>`}
            <button type="button" class="btn-edit-saved-info" data-id="${t.id}" data-saved-id="${escapeAttr(s.id)}">名前・グループ</button>
            <button type="button" class="btn-delete-saved" data-id="${t.id}" data-saved-id="${escapeAttr(s.id)}">削除</button>
          </div>
        </li>
      `;
    };

    const savedGroups = groupedSavedInputs(t);
    const hasNamedGroup = savedGroups.some(([g]) => g !== "");
    // A card that has never used a group looks exactly as it did before: a plain
    // list with nothing to open. Headings show up only once something is grouped.
    const savedInputsHtml = !hasNamedGroup
      ? (savedGroups.length > 0 ? `<ul class="saved-inputs-list">${savedGroups[0][1].map(savedItemHtml).join("")}</ul>` : "")
      : savedGroups.map(([g, items]) => {
          const open = openSavedGroups.has(savedGroupKey(t.id, g));
          const holdsEditing = !!editingSnap && savedGroupOf(editingSnap) === g;
          return `
            <div class="saved-group${open ? " open" : ""}">
              <button type="button" class="saved-group-head" data-id="${t.id}" data-group="${escapeAttr(g)}" aria-expanded="${open}">
                <span class="saved-group-caret" aria-hidden="true">${open ? "▾" : "▸"}</span>
                <span class="saved-group-name">${g ? escapeHtml(g) : "未分類"}</span>
                <span class="saved-group-count">${items.length}</span>
                ${!open && holdsEditing ? `<span class="saved-input-badge">編集中</span>` : ""}
              </button>
              ${open ? `<ul class="saved-inputs-list">${items.map(savedItemHtml).join("")}</ul>` : ""}
            </div>
          `;
        }).join("");

    const savedInputsRow = hasSavableState ? `
      <div class="saved-inputs-row">
        ${savedInputsHtml}
        <button type="button" class="btn-save-inputs" data-id="${t.id}">${editingSnap ? "＋ 別名で保存" : "＋ この内容を保存"}</button>
      </div>
      ${editingSnap ? "" : `<button type="button" class="btn-clear-inputs" data-id="${t.id}">入力をクリア</button>`}
    ` : "";

    return `
      <article class="template-card${editingSnap ? " editing" : ""}" data-id="${t.id}">
        <div class="card-top">
          <h3 class="card-title">${escapeHtml(t.title)}</h3>
        </div>
        ${t.category ? `<span class="card-category">${escapeHtml(t.category)}</span>` : ""}
        ${editingSnap ? `<div class="editing-banner">${savedGroupOf(editingSnap) ? `<span class="editing-banner-group">${escapeHtml(savedGroupOf(editingSnap))}</span>` : ""}「${escapeHtml(editingSnap.name)}」を編集中<span class="editing-banner-hint">変更は自動で保存されます</span></div>` : ""}
        ${slotRows}
        ${fieldRows}
        ${savedInputsRow}
        <p class="card-preview">${escapeHtml(resolveBody(t))}</p>
        <div class="card-actions">
          <button class="btn btn-primary btn-copy" data-id="${t.id}">コピー</button>
          <button class="btn btn-ghost btn-edit" data-id="${t.id}">編集</button>
          <button class="btn btn-ghost btn-danger btn-delete" data-id="${t.id}">削除</button>
        </div>
      </article>
    `;
  }).join("");

  grid.querySelectorAll(".field-input").forEach(autoGrowTextarea);
}

// ---- Dialog: body + slot editing ----

function renderOptionRow(option, i) {
  const row = document.createElement("div");
  row.className = "slot-option-row";
  row.dataset.optionId = option.id;
  row.innerHTML = `
    <input type="text" class="option-label" placeholder="選択肢${i + 1}" value="${escapeAttr(option.label)}" />
    <input type="text" class="option-text" placeholder="テキスト" value="${escapeAttr(option.text)}" />
    <button type="button" class="btn-remove-option" title="この選択肢を削除">×</button>
  `;
  return row;
}

function renderSlotBlock(slot) {
  const block = document.createElement("div");
  block.className = "slot-block";
  block.dataset.slotId = slot.id;

  const head = document.createElement("div");
  head.className = "slot-block-head";
  head.innerHTML = `
    <span class="block-order" title="本文に出てくる順番"></span>
    <input type="text" class="slot-label" placeholder="分岐名 (例: 相手)" value="${escapeAttr(slot.label)}" />
    <button type="button" class="btn-remove-slot" title="この分岐を解除して本文に戻す">解除</button>
  `;
  block.appendChild(head);

  const caption = document.createElement("div");
  caption.className = "slot-option-caption";
  caption.innerHTML = `<span>選択肢の名前</span><span>本文に入るテキスト</span>`;
  block.appendChild(caption);

  const optionsWrap = document.createElement("div");
  optionsWrap.className = "slot-options";
  slot.options.forEach((o, i) => optionsWrap.appendChild(renderOptionRow(o, i)));
  block.appendChild(optionsWrap);

  const addOptionBtn = document.createElement("button");
  addOptionBtn.type = "button";
  addOptionBtn.className = "btn btn-ghost btn-small btn-add-option";
  addOptionBtn.textContent = "+ 選択肢を追加";
  block.appendChild(addOptionBtn);

  refreshOptionRemoveButtons(block);
  return block;
}

function refreshOptionRemoveButtons(block) {
  const rows = block.querySelectorAll(".slot-option-row");
  rows.forEach((row) => {
    row.querySelector(".btn-remove-option").hidden = rows.length <= 1;
  });
}

function setSlotBlocks(slots) {
  slotsEditor.innerHTML = "";
  slots.forEach((s) => slotsEditor.appendChild(renderSlotBlock(s)));
}

function renderFieldBlock(field) {
  const block = document.createElement("div");
  block.className = "slot-block field-block";
  block.dataset.fieldId = field.id;
  block.innerHTML = `
    <div class="slot-block-head">
      <span class="block-order" title="本文に出てくる順番"></span>
      <input type="text" class="field-label" placeholder="入力欄名 (例: お客様名)" value="${escapeAttr(field.label)}" />
      <button type="button" class="btn-remove-field" title="この入力欄を解除して本文に戻す">解除</button>
    </div>
    <div class="slot-option-caption"><span>あらかじめ入れておく値 (省略可)</span></div>
    <textarea class="field-default" rows="1" placeholder="空のままでもOK">${escapeHtml(field.default)}</textarea>
  `;
  return block;
}

function setFieldBlocks(fields) {
  fieldsEditor.innerHTML = "";
  fields.forEach((f) => fieldsEditor.appendChild(renderFieldBlock(f)));
  fieldsEditor.querySelectorAll(".field-default").forEach(autoGrowTextarea);
}

/** The two editors are lists of independent blocks, so "sorted by body order"
 * means physically reordering the DOM nodes. Moving a node blurs whatever is
 * focused inside it, so the caret (and its selection) is put back afterwards —
 * otherwise renaming a branch while the list shifts would drop you out of the
 * input mid-word. Nothing moves at all when the order is already right, which
 * is the common case. */
function reorderEditorBlocks() {
  const active = document.activeElement;
  const isTextEntry = active && ("selectionStart" in active) && active.selectionStart !== null;
  const caret = isTextEntry ? { start: active.selectionStart, end: active.selectionEnd } : null;
  let moved = false;

  [
    { editor: slotsEditor, selector: ".slot-block", idKey: "slotId", brackets: slotBrackets },
    { editor: fieldsEditor, selector: ".field-block", idKey: "fieldId", brackets: fieldBrackets },
  ].forEach(({ editor, selector, idKey, brackets }) => {
    const current = [...editor.querySelectorAll(selector)];
    const ordered = sortByBodyOrder(current, fieldBody.value, (b) => brackets.get(b.dataset[idKey]));
    if (ordered.every((b, i) => b === current[i])) return;
    ordered.forEach((b) => editor.appendChild(b));
    moved = true;
  });

  if (!moved || !active || !active.isConnected || document.activeElement === active) return;
  active.focus({ preventScroll: true });
  if (caret && active.setSelectionRange) active.setSelectionRange(caret.start, caret.end);
}

/** Show each editor section only when it has something in it, and number the
 * blocks 1, 2, 3... in their (body) order so a block is easy to match up with
 * the spot it controls. */
function refreshEditorSections() {
  [
    { section: slotsSection, editor: slotsEditor, selector: ".slot-block", counter: slotsCount },
    { section: fieldsSection, editor: fieldsEditor, selector: ".field-block", counter: fieldsCount },
  ].forEach(({ section, editor, selector, counter }) => {
    const blocks = [...editor.querySelectorAll(selector)];
    section.hidden = blocks.length === 0;
    counter.textContent = blocks.length > 0 ? `${blocks.length}個` : "";
    blocks.forEach((b, i) => {
      const badge = b.querySelector(".block-order");
      if (badge) badge.textContent = String(i + 1);
    });
  });
}

function refreshPreview() {
  const slots = collectSlotsFromEditor();
  const fields = collectFieldsFromEditor();
  const withSlots = resolveWithSlots(fieldBody.value, slots, (slot) => slot.options[0]);
  const resolved = withSlots.replace(FIELD_RE, (match, label) => {
    const f = fields.find((x) => (x.label || "").trim() === label.trim());
    if (!f) return match;
    return f.default ? f.default : match;
  }).trim();
  bodyPreview.textContent = resolved || "(本文を入力すると、ここにコピーされる内容が表示されます)";
  reorderEditorBlocks();
  refreshEditorSections();
  refreshFieldSelect();
}

/** Keep the "既存の入力欄を挿入" dropdown in sync with whatever fields currently exist in the editor. */
function refreshFieldSelect() {
  const blocks = [...fieldsEditor.querySelectorAll(".field-block")];
  insertExistingRow.hidden = blocks.length === 0;
  if (blocks.length === 0) return;

  const prevValue = existingFieldSelect.value;
  existingFieldSelect.innerHTML = blocks.map((b) => {
    const fid = b.dataset.fieldId;
    const label = b.querySelector(".field-label").value.trim() || "(名前未設定の入力欄)";
    return `<option value="${escapeAttr(fid)}">${escapeHtml(label)}</option>`;
  }).join("");
  if ([...existingFieldSelect.options].some((o) => o.value === prevValue)) {
    existingFieldSelect.value = prevValue;
  }
}

/** Suggest the next unused "分岐N" label, checking against slots already in the editor. */
function nextDefaultLabel() {
  const used = new Set([...slotsEditor.querySelectorAll(".slot-label")].map((el) => el.value.trim()));
  let n = 1;
  while (used.has(`分岐${n}`)) n++;
  return `分岐${n}`;
}

/** Disambiguate a label against every OTHER slot currently in the editor, so 【label】
 * placeholders stay uniquely resolvable even if two branches end up named alike. */
function dedupeLabel(slotId, desired) {
  const others = [...slotsEditor.querySelectorAll(".slot-block")]
    .filter((b) => b.dataset.slotId !== slotId)
    .map((b) => b.querySelector(".slot-label").value.trim());
  let candidate = desired;
  let n = 2;
  while (others.includes(candidate)) {
    candidate = `${desired} (${n})`;
    n++;
  }
  return candidate;
}

function syncSlotLabelToBody(block) {
  const slotId = block.dataset.slotId;
  const rawLabel = block.querySelector(".slot-label").value.trim();
  if (!rawLabel) return; // leave the body's existing placeholder alone while the field is empty
  const finalLabel = dedupeLabel(slotId, rawLabel);
  const newBracket = `【${finalLabel}】`;
  const oldBracket = slotBrackets.get(slotId);
  if (oldBracket && oldBracket !== newBracket) {
    fieldBody.value = fieldBody.value.replace(oldBracket, newBracket);
  }
  slotBrackets.set(slotId, newBracket);
}

/** Suggest the next unused "入力欄N" label, checking against fields already in the editor. */
function nextDefaultFieldLabel() {
  const used = new Set([...fieldsEditor.querySelectorAll(".field-label")].map((el) => el.value.trim()));
  let n = 1;
  while (used.has(`入力欄${n}`)) n++;
  return `入力欄${n}`;
}

function dedupeFieldLabel(fieldId, desired) {
  const others = [...fieldsEditor.querySelectorAll(".field-block")]
    .filter((b) => b.dataset.fieldId !== fieldId)
    .map((b) => b.querySelector(".field-label").value.trim());
  let candidate = desired;
  let n = 2;
  while (others.includes(candidate)) {
    candidate = `${desired} (${n})`;
    n++;
  }
  return candidate;
}

function syncFieldLabelToBody(block) {
  const fieldId = block.dataset.fieldId;
  const rawLabel = block.querySelector(".field-label").value.trim();
  if (!rawLabel) return;
  const finalLabel = dedupeFieldLabel(fieldId, rawLabel);
  const newBracket = `〔${finalLabel}〕`;
  const oldBracket = fieldBrackets.get(fieldId);
  if (oldBracket && oldBracket !== newBracket) {
    fieldBody.value = fieldBody.value.replace(oldBracket, newBracket);
  }
  fieldBrackets.set(fieldId, newBracket);
}

// On touch devices, tapping the "make it a branch" button often collapses the
// textarea's text selection before the click handler runs (focus moves off
// the textarea first). Remember the last non-empty selection so the button
// still has something to act on even if the live selection already collapsed.
let rememberedSelection = null;

function captureSelection() {
  const { selectionStart: start, selectionEnd: end } = fieldBody;
  if (start !== end) rememberedSelection = { start, end };
}

["select", "mouseup", "touchend", "keyup"].forEach((evt) => {
  fieldBody.addEventListener(evt, captureSelection);
});

btnMakeSlot.addEventListener("click", () => {
  let { selectionStart: start, selectionEnd: end } = fieldBody;
  if (start === end && rememberedSelection) {
    ({ start, end } = rememberedSelection);
  }
  if (start === end) {
    showToast("先に本文中の文字を選択してください");
    return;
  }
  rememberedSelection = null;
  const selectedText = fieldBody.value.slice(start, end);
  const slotId = uid();
  const label = nextDefaultLabel();
  const bracket = `【${label}】`;

  fieldBody.value = fieldBody.value.slice(0, start) + bracket + fieldBody.value.slice(end);
  fieldBody.focus();
  fieldBody.setSelectionRange(start + bracket.length, start + bracket.length);
  slotBrackets.set(slotId, bracket);

  const slot = {
    id: slotId,
    label,
    options: [
      { id: uid(), label: "選択肢1", text: selectedText },
      { id: uid(), label: "選択肢2", text: "" },
    ],
  };
  const block = renderSlotBlock(slot);
  slotsEditor.appendChild(block);
  // Slide it into its place in the body's order before the caret moves into it.
  reorderEditorBlocks();
  const labelInput = block.querySelector(".slot-label");
  labelInput.focus();
  labelInput.select();
  refreshPreview();
});

slotsEditor.addEventListener("click", (e) => {
  const removeOptionBtn = e.target.closest(".btn-remove-option");
  const addOptionBtn = e.target.closest(".btn-add-option");
  const removeSlotBtn = e.target.closest(".btn-remove-slot");

  if (removeOptionBtn) {
    const block = removeOptionBtn.closest(".slot-block");
    if (block.querySelectorAll(".slot-option-row").length <= 1) return;
    removeOptionBtn.closest(".slot-option-row").remove();
    refreshOptionRemoveButtons(block);
    refreshPreview();
  } else if (addOptionBtn) {
    const block = addOptionBtn.closest(".slot-block");
    const optionsWrap = block.querySelector(".slot-options");
    const newRow = renderOptionRow({ id: uid(), label: "", text: "" }, optionsWrap.children.length);
    optionsWrap.appendChild(newRow);
    refreshOptionRemoveButtons(block);
    newRow.querySelector(".option-text").focus();
  } else if (removeSlotBtn) {
    const block = removeSlotBtn.closest(".slot-block");
    const slotId = block.dataset.slotId;
    const firstOptionText = block.querySelector(".option-text").value;
    const bracket = slotBrackets.get(slotId) || `【${block.querySelector(".slot-label").value.trim() || "分岐"}】`;
    fieldBody.value = fieldBody.value.replace(bracket, firstOptionText);
    slotBrackets.delete(slotId);
    block.remove();
    refreshPreview();
  }
});

slotsEditor.addEventListener("input", (e) => {
  if (e.target.classList.contains("slot-label")) {
    syncSlotLabelToBody(e.target.closest(".slot-block"));
  }
  refreshPreview();
});

btnMakeField.addEventListener("click", () => {
  let { selectionStart: start, selectionEnd: end } = fieldBody;
  if (start === end && rememberedSelection) {
    ({ start, end } = rememberedSelection);
  }
  // Unlike a branch, an empty selection is fine here — it just inserts an empty field at the cursor.
  rememberedSelection = null;
  const defaultVal = start === end ? "" : fieldBody.value.slice(start, end);
  const fieldId = uid();
  const label = nextDefaultFieldLabel();
  const bracket = `〔${label}〕`;

  fieldBody.value = fieldBody.value.slice(0, start) + bracket + fieldBody.value.slice(end);
  fieldBody.focus();
  fieldBody.setSelectionRange(start + bracket.length, start + bracket.length);
  fieldBrackets.set(fieldId, bracket);

  const field = { id: fieldId, label, default: defaultVal };
  const block = renderFieldBlock(field);
  fieldsEditor.appendChild(block);
  autoGrowTextarea(block.querySelector(".field-default"));
  reorderEditorBlocks();
  const labelInput = block.querySelector(".field-label");
  labelInput.focus();
  labelInput.select();
  refreshPreview();
});

fieldsEditor.addEventListener("click", (e) => {
  const removeFieldBtn = e.target.closest(".btn-remove-field");
  if (!removeFieldBtn) return;
  const block = removeFieldBtn.closest(".field-block");
  const fieldId = block.dataset.fieldId;
  const defaultVal = block.querySelector(".field-default").value;
  const bracket = fieldBrackets.get(fieldId) || `〔${block.querySelector(".field-label").value.trim() || "入力欄"}〕`;
  fieldBody.value = fieldBody.value.replace(bracket, defaultVal);
  fieldBrackets.delete(fieldId);
  block.remove();
  refreshPreview();
});

fieldsEditor.addEventListener("input", (e) => {
  if (e.target.classList.contains("field-label")) {
    syncFieldLabelToBody(e.target.closest(".field-block"));
  } else if (e.target.classList.contains("field-default")) {
    autoGrowTextarea(e.target);
  }
  refreshPreview();
});

fieldBody.addEventListener("input", refreshPreview);

btnInsertExistingField.addEventListener("click", () => {
  const fid = existingFieldSelect.value;
  const bracket = fieldBrackets.get(fid);
  if (!fid || !bracket) return;

  let { selectionStart: start, selectionEnd: end } = fieldBody;
  if (start === end && rememberedSelection) {
    ({ start, end } = rememberedSelection);
  }
  rememberedSelection = null;
  fieldBody.value = fieldBody.value.slice(0, start) + bracket + fieldBody.value.slice(end);
  fieldBody.focus();
  fieldBody.setSelectionRange(start + bracket.length, start + bracket.length);
  refreshPreview();
});

function openDialogForNew() {
  dialogTitle.textContent = "新規テンプレート";
  fieldId.value = "";
  fieldTitle.value = "";
  fieldCategory.value = "";
  fieldBody.value = "";
  rememberedSelection = null;
  slotBrackets.clear();
  fieldBrackets.clear();
  setSlotBlocks([]);
  setFieldBlocks([]);
  dialog.showModal();
  fieldTitle.focus();
  refreshPreview();
}

function openDialogForEdit(id) {
  const t = templates.find((x) => x.id === id);
  if (!t) return;
  dialogTitle.textContent = "テンプレートを編集";
  fieldId.value = t.id;
  fieldTitle.value = t.title;
  fieldCategory.value = t.category;
  fieldBody.value = t.body;
  rememberedSelection = null;
  slotBrackets.clear();
  fieldBrackets.clear();
  const clonedSlots = t.slots.map((s) => ({ ...s, options: s.options.map((o) => ({ ...o })) }));
  clonedSlots.forEach((s) => slotBrackets.set(s.id, `【${s.label}】`));
  setSlotBlocks(clonedSlots);
  const clonedFields = t.fields.map((f) => ({ ...f }));
  clonedFields.forEach((f) => fieldBrackets.set(f.id, `〔${f.label}〕`));
  setFieldBlocks(clonedFields);
  dialog.showModal();
  fieldTitle.focus();
  refreshPreview();
}

function collectSlotsFromEditor() {
  const used = new Set();
  return [...slotsEditor.querySelectorAll(".slot-block")].map((block, i) => {
    const slotId = block.dataset.slotId;
    let label = block.querySelector(".slot-label").value.trim();
    if (!label) {
      const bracket = slotBrackets.get(slotId);
      label = bracket ? bracket.slice(1, -1) : `分岐${i + 1}`;
    }
    let candidate = label, n = 2;
    while (used.has(candidate)) { candidate = `${label} (${n})`; n++; }
    used.add(candidate);

    return {
      id: slotId,
      label: candidate,
      options: [...block.querySelectorAll(".slot-option-row")].map((row) => ({
        id: row.dataset.optionId,
        label: row.querySelector(".option-label").value.trim(),
        text: row.querySelector(".option-text").value,
      })),
    };
  }).filter((s) => s.options.length > 0);
}

function collectFieldsFromEditor() {
  const used = new Set();
  return [...fieldsEditor.querySelectorAll(".field-block")].map((block, i) => {
    const fid = block.dataset.fieldId;
    let label = block.querySelector(".field-label").value.trim();
    if (!label) {
      const bracket = fieldBrackets.get(fid);
      label = bracket ? bracket.slice(1, -1) : `入力欄${i + 1}`;
    }
    let candidate = label, n = 2;
    while (used.has(candidate)) { candidate = `${label} (${n})`; n++; }
    used.add(candidate);

    return {
      id: fid,
      label: candidate,
      default: block.querySelector(".field-default").value,
    };
  });
}

form.addEventListener("submit", () => {
  const now = Date.now();
  const id = fieldId.value;
  const title = fieldTitle.value.trim();
  const category = fieldCategory.value.trim();
  const body = fieldBody.value;
  const slots = collectSlotsFromEditor();
  const fields = collectFieldsFromEditor();

  if (!title || !body.trim()) return;

  if (id) {
    const t = templates.find((x) => x.id === id);
    if (t) {
      t.title = title;
      t.category = category;
      t.body = body;
      t.slots = slots;
      t.fields = fields;
      t.updatedAt = now;
    }
  } else {
    templates.push({ id: uid(), title, category, body, slots, fields, savedInputs: [], createdAt: now, updatedAt: now });
  }

  saveTemplates();
  render();
});

document.getElementById("btn-cancel").addEventListener("click", () => dialog.close());
document.getElementById("btn-new").addEventListener("click", openDialogForNew);
document.getElementById("btn-new-empty").addEventListener("click", openDialogForNew);

grid.addEventListener("click", async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const id = target.dataset.id;
  if (!id) return;

  if (target.classList.contains("branch-tab")) {
    const slotId = target.dataset.slot;
    const optionId = target.dataset.option;
    selections.set(`${id}:${slotId}`, optionId);
    const t = templates.find((x) => x.id === id);
    if (t) {
      cancelAutoSave();
      persistActiveSavedInput(t);
    }
    render();
  } else if (target.classList.contains("btn-copy")) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    try {
      await navigator.clipboard.writeText(resolveBody(t));
      showToast("コピーしました ✓");
    } catch {
      showToast("コピーに失敗しました");
    }
  } else if (target.classList.contains("btn-edit")) {
    openDialogForEdit(id);
  } else if (target.classList.contains("btn-delete")) {
    const t = templates.find((x) => x.id === id);
    if (t && confirm(`「${t.title}」を削除しますか?`)) {
      templates = templates.filter((x) => x.id !== id);
      saveTemplates();
      render();
    }
  } else if (target.classList.contains("btn-clear-inputs")) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const hasTypedValue = t.fields.some((f) => fieldValues.has(`${id}:${f.id}`));
    const hasChangedBranch = t.slots.some((s) => selections.has(`${id}:${s.id}`));
    if (!hasTypedValue && !hasChangedBranch) {
      showToast("クリアする入力はありません");
      return;
    }
    clearLiveInputs(t);
    render();
    showToast("入力をクリアしました");
  } else if (target.classList.contains("btn-save-inputs")) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    // The name starts blank on purpose: pre-filling it with the first field's text
    // meant dismissing a suggestion that was almost never the name you wanted.
    openSavedInputDialog({ mode: "create", templateId: t.id, name: "", group: defaultGroupForNewSave(t) });
  } else if (target.classList.contains("saved-group-head")) {
    const key = savedGroupKey(id, target.dataset.group || "");
    if (openSavedGroups.has(key)) openSavedGroups.delete(key);
    else openSavedGroups.add(key);
    render();
  } else if (target.classList.contains("btn-copy-saved")) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    // A half-typed edit belongs in the saved input before we read it back out.
    flushAutoSave();
    const snap = t.savedInputs.find((s) => s.id === target.dataset.savedId);
    if (!snap) return;
    try {
      await navigator.clipboard.writeText(resolveSavedBody(t, snap));
      showToast(`「${snap.name}」をコピーしました ✓`);
    } catch {
      showToast("コピーに失敗しました");
    }
  } else if (target.classList.contains("btn-edit-saved")) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const snap = t.savedInputs.find((s) => s.id === target.dataset.savedId);
    if (!snap) return;
    flushAutoSave();
    persistActiveSavedInput(t);
    applySavedInput(t, snap);
    editingSavedInput.set(t.id, snap.id);
    openSavedGroups.add(savedGroupKey(t.id, savedGroupOf(snap)));
    render();
    showToast(`「${snap.name}」を編集中です`);
  } else if (target.classList.contains("btn-stop-editing")) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    flushAutoSave();
    const snap = activeSavedInput(t);
    if (snap) persistActiveSavedInput(t);
    // Leaving editing mode empties the card too, same as saving: the content is
    // already written into the saved input, so what's left on screen is just in
    // the way of the next one.
    editingSavedInput.delete(t.id);
    clearLiveInputs(t);
    render();
    showToast(snap ? `「${snap.name}」の編集を終え、入力をクリアしました` : "編集を終え、入力をクリアしました");
  } else if (target.classList.contains("btn-edit-saved-info")) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const snap = t.savedInputs.find((s) => s.id === target.dataset.savedId);
    if (!snap) return;
    openSavedInputDialog({ mode: "edit", templateId: t.id, savedId: snap.id, name: snap.name, group: savedGroupOf(snap) });
  } else if (target.classList.contains("btn-delete-saved")) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const snap = t.savedInputs.find((s) => s.id === target.dataset.savedId);
    if (!snap) return;
    if (!confirm(`保存した入力「${snap.name}」を削除しますか?`)) return;
    if (editingSavedInput.get(t.id) === snap.id) {
      cancelAutoSave();
      editingSavedInput.delete(t.id);
    }
    t.savedInputs = t.savedInputs.filter((s) => s.id !== snap.id);
    saveTemplates();
    render();
  }
});

// ---- 一時保存の名前・グループを決めるダイアログ ----

const savedInputDialog = document.getElementById("saved-input-dialog");
const savedInputForm = document.getElementById("saved-input-form");
const savedInputDialogTitle = document.getElementById("saved-input-dialog-title");
const savedInputNameField = document.getElementById("saved-input-name");
const savedInputGroupSelect = document.getElementById("saved-input-group");
const savedInputNewGroupField = document.getElementById("saved-input-new-group");
const savedInputSubmit = document.getElementById("btn-saved-input-submit");

// Option values are prefixed so a group can be named anything at all — including
// whatever sentinel we would otherwise have picked for "new group".
const NEW_GROUP_OPTION = "new";
const groupOptionValue = (g) => `g:${g}`;

/** What the dialog is currently filling in: a brand new saved input, or an existing one. */
let savedInputDialogCtx = null;

function syncNewGroupField() {
  const isNew = savedInputGroupSelect.value === NEW_GROUP_OPTION;
  savedInputNewGroupField.hidden = !isNew;
  if (isNew) savedInputNewGroupField.focus();
}

function selectedGroupName() {
  const v = savedInputGroupSelect.value;
  if (v === NEW_GROUP_OPTION) return savedInputNewGroupField.value.trim();
  return v.startsWith("g:") ? v.slice(2).trim() : "";
}

function openSavedInputDialog(ctx) {
  const t = templates.find((x) => x.id === ctx.templateId);
  if (!t) return;
  savedInputDialogCtx = ctx;
  savedInputDialogTitle.textContent = ctx.mode === "create" ? "この入力内容を保存" : "名前とグループ";
  savedInputSubmit.textContent = ctx.mode === "create" ? "保存" : "変更する";
  savedInputNameField.value = ctx.name || "";

  const names = existingGroupNames(t);
  const wanted = (ctx.group || "").trim();
  savedInputGroupSelect.innerHTML = [
    `<option value="${groupOptionValue("")}">未分類</option>`,
    ...names.map((g) => `<option value="${escapeAttr(groupOptionValue(g))}">${escapeHtml(g)}</option>`),
    `<option value="${NEW_GROUP_OPTION}">＋ 新しいグループ…</option>`,
  ].join("");
  savedInputGroupSelect.value = groupOptionValue(names.includes(wanted) ? wanted : "");
  savedInputNewGroupField.value = "";
  savedInputNewGroupField.hidden = true;

  if (typeof savedInputDialog.showModal === "function") savedInputDialog.showModal();
  savedInputNameField.focus();
  if (typeof savedInputNameField.select === "function") savedInputNameField.select();
}

function closeSavedInputDialog() {
  savedInputDialogCtx = null;
  if (typeof savedInputDialog.close === "function") savedInputDialog.close();
}

function commitSavedInputDialog() {
  const ctx = savedInputDialogCtx;
  if (!ctx) return;
  const t = templates.find((x) => x.id === ctx.templateId);
  if (!t) {
    closeSavedInputDialog();
    return;
  }
  const name = savedInputNameField.value.trim();
  if (!name) {
    showToast("名前を入力してください");
    savedInputNameField.focus();
    return;
  }
  if (savedInputGroupSelect.value === NEW_GROUP_OPTION && !selectedGroupName()) {
    showToast("グループ名を入力してください");
    savedInputNewGroupField.focus();
    return;
  }
  const group = selectedGroupName();
  // The group you just filed something into is the one you want to see.
  openSavedGroups.add(savedGroupKey(t.id, group));

  if (ctx.mode === "create") {
    // Write any half-typed edit into the saved input we are about to leave behind.
    flushAutoSave();
    const { values, selections: branchSelections } = captureCurrentState(t);
    t.savedInputs.push({ id: uid(), name, group, values, selections: branchSelections, savedAt: Date.now() });
    // Saving is a "put this away and start the next one" action: the card goes back
    // to a blank state. Editing mode has to end with it — otherwise the auto-save
    // would write the now-empty inputs straight back over what was just saved.
    cancelAutoSave();
    editingSavedInput.delete(t.id);
    clearLiveInputs(t);
    saveTemplates();
    closeSavedInputDialog();
    render();
    showToast(`「${name}」を保存し、入力をクリアしました`);
    return;
  }

  const snap = t.savedInputs.find((x) => x.id === ctx.savedId);
  if (!snap) {
    closeSavedInputDialog();
    return;
  }
  const moved = group !== savedGroupOf(snap);
  snap.name = name;
  snap.group = group;
  saveTemplates();
  closeSavedInputDialog();
  render();
  showToast(moved
    ? `「${name}」を${group ? `「${group}」` : "未分類"}に移動しました`
    : `名前を「${name}」に変更しました`);
}

savedInputGroupSelect.addEventListener("change", syncNewGroupField);
savedInputForm.addEventListener("submit", (e) => {
  // Validation lives in commit so a missing name can keep the dialog open.
  e.preventDefault();
  commitSavedInputDialog();
});
document.getElementById("btn-saved-input-cancel").addEventListener("click", closeSavedInputDialog);
savedInputDialog.addEventListener("close", () => { savedInputDialogCtx = null; });

// Typing into a card's field input must not trigger a full re-render (that would
// destroy the input and drop focus/cursor mid-keystroke) — just patch that one
// card's preview text in place.
grid.addEventListener("input", (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains("field-input")) return;
  autoGrowTextarea(target);
  const id = target.dataset.id;
  const fid = target.dataset.field;
  fieldValues.set(`${id}:${fid}`, target.value);
  const t = templates.find((x) => x.id === id);
  if (!t) return;
  const card = target.closest(".template-card");
  const preview = card?.querySelector(".card-preview");
  if (preview) preview.textContent = resolveBody(t);
  if (activeSavedInput(t)) scheduleAutoSave(t, card);
});

// Do not leave a half-typed edit unwritten when focus leaves the input or the page goes away.
grid.addEventListener("focusout", (e) => {
  const target = e.target;
  if (target instanceof HTMLElement && target.classList.contains("field-input")) flushAutoSave();
});
window.addEventListener("beforeunload", flushAutoSave);
window.addEventListener("pagehide", flushAutoSave);

searchInput.addEventListener("input", render);
categoryFilter.addEventListener("change", render);

document.getElementById("btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(templates, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `templates-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error("invalid format");

    const existingIds = new Set(templates.map((t) => t.id));
    for (const item of imported) {
      if (!item || typeof item.title !== "string") continue;
      const migrated = migrateTemplate(item);
      if (!migrated.body.trim()) continue;
      const newId = item.id && !existingIds.has(item.id) ? item.id : uid();
      templates.push({
        id: newId,
        title: item.title,
        category: typeof item.category === "string" ? item.category : "",
        body: migrated.body,
        slots: migrated.slots.map((s) => ({
          id: s.id || uid(),
          label: s.label || "",
          options: s.options.map((o) => ({ id: o.id || uid(), label: o.label || "", text: o.text })),
        })),
        fields: migrated.fields.map((f) => ({ id: f.id || uid(), label: f.label || "", default: f.default || "" })),
        savedInputs: migrated.savedInputs.map((s) => ({
          id: s.id || uid(),
          name: s.name || "",
          group: typeof s.group === "string" ? s.group : "",
          values: s.values && typeof s.values === "object" ? s.values : {},
          selections: s.selections && typeof s.selections === "object" ? s.selections : {},
          savedAt: s.savedAt || Date.now(),
        })),
        createdAt: item.createdAt || Date.now(),
        updatedAt: item.updatedAt || Date.now(),
      });
      existingIds.add(newId);
    }
    saveTemplates();
    render();
    showToast("読み込みました");
  } catch {
    showToast("読み込みに失敗しました");
  } finally {
    e.target.value = "";
  }
});

render();

// Keep the fixed header from overlapping content: measure its real height
// (it wraps to two lines on narrow screens) and feed it back as padding.
const appHeader = document.querySelector(".app-header");
if (appHeader) {
  const syncHeaderHeight = () => {
    document.documentElement.style.setProperty("--header-h", `${appHeader.offsetHeight}px`);
  };
  new ResizeObserver(syncHeaderHeight).observe(appHeader);
  syncHeaderHeight();
}

const versionEl = document.getElementById("app-version");
if (versionEl) {
  const version = window.APP_VERSION || "0.0.0";
  const builtAt = window.APP_BUILT_AT ? new Date(window.APP_BUILT_AT) : null;
  const builtStr = builtAt
    ? `${builtAt.getMonth() + 1}/${builtAt.getDate()} ${String(builtAt.getHours()).padStart(2, "0")}:${String(builtAt.getMinutes()).padStart(2, "0")}`
    : "不明";
  versionEl.textContent = `ver${version} (最終更新: ${builtStr})`;
}
