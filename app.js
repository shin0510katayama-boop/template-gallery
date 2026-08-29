const STORAGE_KEY = "templateCopier.templates.v1";
const BRACKET_RE = /【([^【】]*)】/g;
const FIELD_RE = /〔([^〔〕]*)〕/g;
const LEGACY_TOKEN_RE = /\{\{slot:[a-zA-Z0-9-]+\}\}/;

/** @typedef {{id:string,label:string,text:string}} Option */
/** @typedef {{id:string,label:string,options:Option[]}} Slot */
/** @typedef {{id:string,label:string,default:string}} Field */
/** @typedef {{id:string,title:string,category:string,body:string,slots:Slot[],fields:Field[],createdAt:number,updatedAt:number}} Template */

/** @type {Template[]} */
let templates = loadTemplates();

/** Which option is currently selected per template+slot (transient, not persisted). Key: `${templateId}:${slotId}` -> optionId */
const selections = new Map();

/** What's currently typed into each free-input field (transient, not persisted). Key: `${templateId}:${fieldId}` -> text */
const fieldValues = new Map();

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
const btnMakeField = document.getElementById("btn-make-field");
const fieldsEditor = document.getElementById("fields-editor");
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

  if (typeof t.body === "string" && Array.isArray(t.slots)) {
    const withFields = { ...t, fields };
    return LEGACY_TOKEN_RE.test(t.body) ? convertLegacyTokens(t.body, t.slots, withFields) : withFields;
  }

  if (Array.isArray(t.branches)) {
    if (t.branches.length <= 1) {
      return { ...t, body: t.branches[0]?.content ?? "", slots: [], fields };
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
    };
  }

  return { ...t, body: t.content ?? "", slots: [], fields };
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

function optionLabel(o, i) { return o.label.trim() || `選択肢${i + 1}`; }
function slotLabel(s, i) { return s.label.trim() || `分岐${i + 1}`; }
function fieldLabel(f, i) { return f.label.trim() || `入力欄${i + 1}`; }

function selectedOptionId(templateId, slot) {
  const key = `${templateId}:${slot.id}`;
  const chosen = selections.get(key);
  return slot.options.some((o) => o.id === chosen) ? chosen : slot.options[0]?.id;
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
    const slotRows = t.slots.map((s, si) => {
      const activeId = selectedOptionId(t.id, s);
      const pills = s.options.map((o, oi) => `
        <button type="button" class="branch-tab ${o.id === activeId ? "active" : ""}" data-id="${t.id}" data-slot="${s.id}" data-option="${o.id}">${escapeHtml(optionLabel(o, oi))}</button>
      `).join("");
      return `<div class="branch-tabs"><span class="branch-tabs-label">${escapeHtml(slotLabel(s, si))}</span>${pills}</div>`;
    }).join("");

    const fieldRows = t.fields.map((f, fi) => {
      const key = `${t.id}:${f.id}`;
      const val = fieldValues.has(key) ? fieldValues.get(key) : f.default;
      return `<div class="field-row">
        <span class="field-row-label">${escapeHtml(fieldLabel(f, fi))}</span>
        <input type="text" class="field-input" data-id="${t.id}" data-field="${f.id}" value="${escapeAttr(val)}" placeholder="入力してください" />
      </div>`;
    }).join("");

    return `
      <article class="template-card" data-id="${t.id}">
        <div class="card-top">
          <h3 class="card-title">${escapeHtml(t.title)}</h3>
        </div>
        ${t.category ? `<span class="card-category">${escapeHtml(t.category)}</span>` : ""}
        ${slotRows}
        ${fieldRows}
        <p class="card-preview">${escapeHtml(resolveBody(t))}</p>
        <div class="card-actions">
          <button class="btn btn-primary btn-copy" data-id="${t.id}">コピー</button>
          <button class="btn btn-ghost btn-edit" data-id="${t.id}">編集</button>
          <button class="btn btn-ghost btn-danger btn-delete" data-id="${t.id}">削除</button>
        </div>
      </article>
    `;
  }).join("");
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
    <input type="text" class="slot-label" placeholder="分岐名 (例: 相手)" value="${escapeAttr(slot.label)}" />
    <button type="button" class="btn-remove-slot" title="分岐を解除して本文に戻す">分岐を解除</button>
  `;
  block.appendChild(head);

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
      <input type="text" class="field-label" placeholder="入力欄名 (例: お客様名)" value="${escapeAttr(field.label)}" />
      <button type="button" class="btn-remove-field" title="入力欄を解除して本文に戻す">解除</button>
    </div>
    <input type="text" class="field-default" placeholder="デフォルト値 (省略可)" value="${escapeAttr(field.default)}" />
  `;
  return block;
}

function setFieldBlocks(fields) {
  fieldsEditor.innerHTML = "";
  fields.forEach((f) => fieldsEditor.appendChild(renderFieldBlock(f)));
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
  }
  refreshPreview();
});

fieldBody.addEventListener("input", refreshPreview);

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
    templates.push({ id: uid(), title, category, body, slots, fields, createdAt: now, updatedAt: now });
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
  }
});

// Typing into a card's field input must not trigger a full re-render (that would
// destroy the input and drop focus/cursor mid-keystroke) — just patch that one
// card's preview text in place.
grid.addEventListener("input", (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains("field-input")) return;
  const id = target.dataset.id;
  const fid = target.dataset.field;
  fieldValues.set(`${id}:${fid}`, target.value);
  const t = templates.find((x) => x.id === id);
  if (!t) return;
  const card = target.closest(".template-card");
  const preview = card?.querySelector(".card-preview");
  if (preview) preview.textContent = resolveBody(t);
});

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
