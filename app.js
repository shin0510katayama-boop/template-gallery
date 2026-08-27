const STORAGE_KEY = "templateCopier.templates.v1";
const TOKEN_RE = /\{\{slot:([a-zA-Z0-9-]+)\}\}/g;

/** @typedef {{id:string,label:string,text:string}} Option */
/** @typedef {{id:string,label:string,options:Option[]}} Slot */
/** @typedef {{id:string,title:string,category:string,body:string,slots:Slot[],createdAt:number,updatedAt:number}} Template */

/** @type {Template[]} */
let templates = loadTemplates();

/** Which option is currently selected per template+slot (transient, not persisted). Key: `${templateId}:${slotId}` -> optionId */
const selections = new Map();

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

const toast = document.getElementById("toast");

/** In-memory slot list for whatever template is currently open in the dialog. */
let editingSlots = [];

function loadTemplates() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return parsed.map(migrateTemplate);
  } catch {
    return [];
  }
}

// Older saves used a single `content` string, then a `branches` array of
// full-body alternatives. Fold either into the current body+slots shape:
// a `branches` array with more than one entry becomes a single slot that
// spans the whole body, one option per old branch.
function migrateTemplate(t) {
  if (typeof t.body === "string" && Array.isArray(t.slots)) return t;

  if (Array.isArray(t.branches)) {
    if (t.branches.length <= 1) {
      return { ...t, body: t.branches[0]?.content ?? "", slots: [] };
    }
    const slotId = shortId();
    return {
      ...t,
      body: `{{slot:${slotId}}}`,
      slots: [{
        id: slotId,
        label: "パターン",
        options: t.branches.map((b) => ({ id: b.id || uid(), label: b.label || "", text: b.content })),
      }],
    };
  }

  return { ...t, body: t.content ?? "", slots: [] };
}

function saveTemplates() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

// Short id for inline body tokens, so `{{slot:xxxxxx}}` stays readable in the textarea.
function shortId() {
  return Math.random().toString(36).slice(2, 8);
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

function selectedOptionId(templateId, slot) {
  const key = `${templateId}:${slot.id}`;
  const chosen = selections.get(key);
  return slot.options.some((o) => o.id === chosen) ? chosen : slot.options[0]?.id;
}

/** Replace every {{slot:ID}} token in the body with the currently selected option's text. */
function resolveBody(t) {
  return t.body.replace(TOKEN_RE, (match, slotId) => {
    const slot = t.slots.find((s) => s.id === slotId);
    if (!slot || slot.options.length === 0) return "";
    const optId = selectedOptionId(t.id, slot);
    return slot.options.find((o) => o.id === optId)?.text ?? "";
  });
}

function render() {
  renderCategoryOptions();

  const query = searchInput.value.trim().toLowerCase();
  const category = categoryFilter.value;

  const matchesQuery = (t) => {
    if (!query) return true;
    if (t.title.toLowerCase().includes(query)) return true;
    if (resolveBody(t).toLowerCase().includes(query)) return true;
    return t.slots.some((s) => s.options.some((o) => o.text.toLowerCase().includes(query) || o.label.toLowerCase().includes(query)));
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
      return `<div class="branch-tabs" title="${escapeAttr(slotLabel(s, si))}">${pills}</div>`;
    }).join("");

    return `
      <article class="template-card" data-id="${t.id}">
        <div class="card-top">
          <h3 class="card-title">${escapeHtml(t.title)}</h3>
        </div>
        ${t.category ? `<span class="card-category">${escapeHtml(t.category)}</span>` : ""}
        ${slotRows}
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
  editingSlots = slots;
  slotsEditor.innerHTML = "";
  slots.forEach((s) => slotsEditor.appendChild(renderSlotBlock(s)));
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
  const slotId = shortId();
  const token = `{{slot:${slotId}}}`;

  fieldBody.value = fieldBody.value.slice(0, start) + token + fieldBody.value.slice(end);
  fieldBody.focus();
  fieldBody.setSelectionRange(start + token.length, start + token.length);

  const slot = {
    id: slotId,
    label: "",
    options: [
      { id: uid(), label: "選択肢1", text: selectedText },
      { id: uid(), label: "選択肢2", text: "" },
    ],
  };
  const block = renderSlotBlock(slot);
  slotsEditor.appendChild(block);
  editingSlots.push(slot);
  block.querySelector(".slot-label").focus();
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
    const token = `{{slot:${slotId}}}`;
    fieldBody.value = fieldBody.value.replace(token, firstOptionText);
    block.remove();
  }
});

function openDialogForNew() {
  dialogTitle.textContent = "新規テンプレート";
  fieldId.value = "";
  fieldTitle.value = "";
  fieldCategory.value = "";
  fieldBody.value = "";
  rememberedSelection = null;
  setSlotBlocks([]);
  dialog.showModal();
  fieldTitle.focus();
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
  setSlotBlocks(t.slots.map((s) => ({ ...s, options: s.options.map((o) => ({ ...o })) })));
  dialog.showModal();
  fieldTitle.focus();
}

function collectSlotsFromEditor() {
  return [...slotsEditor.querySelectorAll(".slot-block")].map((block) => ({
    id: block.dataset.slotId,
    label: block.querySelector(".slot-label").value.trim(),
    options: [...block.querySelectorAll(".slot-option-row")].map((row) => ({
      id: row.dataset.optionId,
      label: row.querySelector(".option-label").value.trim(),
      text: row.querySelector(".option-text").value,
    })),
  })).filter((s) => s.options.length > 0);
}

form.addEventListener("submit", () => {
  const now = Date.now();
  const id = fieldId.value;
  const title = fieldTitle.value.trim();
  const category = fieldCategory.value.trim();
  const body = fieldBody.value;
  const slots = collectSlotsFromEditor();

  if (!title || !body.trim()) return;

  if (id) {
    const t = templates.find((x) => x.id === id);
    if (t) {
      t.title = title;
      t.category = category;
      t.body = body;
      t.slots = slots;
      t.updatedAt = now;
    }
  } else {
    templates.push({ id: uid(), title, category, body, slots, createdAt: now, updatedAt: now });
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
