const STORAGE_KEY = "templateCopier.templates.v1";

/** @typedef {{id:string,label:string,content:string}} Branch */
/** @typedef {{id:string,title:string,category:string,branches:Branch[],createdAt:number,updatedAt:number}} Template */

/** @type {Template[]} */
let templates = loadTemplates();

/** Which branch index is currently shown/copied per template id (transient, not persisted). @type {Map<string, number>} */
const selectedBranch = new Map();

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
const branchesEditor = document.getElementById("branches-editor");
const btnAddBranch = document.getElementById("btn-add-branch");

const toast = document.getElementById("toast");

function loadTemplates() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return parsed.map(migrateTemplate);
  } catch {
    return [];
  }
}

// Older saves stored a single `content` string per template. Fold that into
// a one-item `branches` array so both shapes render the same way.
function migrateTemplate(t) {
  if (Array.isArray(t.branches) && t.branches.length > 0) return t;
  return {
    ...t,
    branches: [{ id: uid(), label: "本文", content: t.content ?? "" }],
  };
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

function branchLabel(b, i) { return b.label.trim() || `分岐${i + 1}`; }

function currentBranchIndex(t) {
  const idx = selectedBranch.get(t.id) ?? 0;
  return Math.min(idx, t.branches.length - 1);
}

function render() {
  renderCategoryOptions();

  const query = searchInput.value.trim().toLowerCase();
  const category = categoryFilter.value;

  const matchesQuery = (t) => {
    if (!query) return true;
    if (t.title.toLowerCase().includes(query)) return true;
    return t.branches.some((b) => b.content.toLowerCase().includes(query) || b.label.toLowerCase().includes(query));
  };

  const filtered = templates
    .filter((t) => !category || t.category === category)
    .filter(matchesQuery)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  emptyState.hidden = templates.length > 0;
  grid.hidden = templates.length === 0;

  grid.innerHTML = filtered.map((t) => {
    const idx = currentBranchIndex(t);
    const active = t.branches[idx];
    const tabs = t.branches.length > 1
      ? `<div class="branch-tabs">${t.branches.map((b, i) => `
          <button type="button" class="branch-tab ${i === idx ? "active" : ""}" data-id="${t.id}" data-idx="${i}">${escapeHtml(branchLabel(b, i))}</button>
        `).join("")}</div>`
      : "";

    return `
      <article class="template-card" data-id="${t.id}">
        <div class="card-top">
          <h3 class="card-title">${escapeHtml(t.title)}</h3>
        </div>
        ${t.category ? `<span class="card-category">${escapeHtml(t.category)}</span>` : ""}
        ${tabs}
        <p class="card-preview">${escapeHtml(active.content)}</p>
        <div class="card-actions">
          <button class="btn btn-primary btn-copy" data-id="${t.id}">コピー</button>
          <button class="btn btn-ghost btn-edit" data-id="${t.id}">編集</button>
          <button class="btn btn-ghost btn-danger btn-delete" data-id="${t.id}">削除</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderBranchRow(branch) {
  const row = document.createElement("div");
  row.className = "branch-row";
  row.dataset.branchId = branch.id;
  row.innerHTML = `
    <div class="branch-row-head">
      <input type="text" class="branch-label" placeholder="分岐名 (例: 面接後)" value="${escapeAttr(branch.label)}" />
      <button type="button" class="btn-remove-branch" title="この分岐を削除">×</button>
    </div>
    <textarea class="branch-content" rows="6" required placeholder="コピーしたいテキストを入力...">${escapeHtml(branch.content)}</textarea>
  `;
  return row;
}

function refreshRemoveButtons() {
  const rows = branchesEditor.querySelectorAll(".branch-row");
  rows.forEach((row) => {
    const btn = row.querySelector(".btn-remove-branch");
    btn.hidden = rows.length <= 1;
  });
}

function setBranchRows(branches) {
  branchesEditor.innerHTML = "";
  branches.forEach((b) => branchesEditor.appendChild(renderBranchRow(b)));
  refreshRemoveButtons();
}

btnAddBranch.addEventListener("click", () => {
  branchesEditor.appendChild(renderBranchRow({ id: uid(), label: "", content: "" }));
  refreshRemoveButtons();
});

branchesEditor.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-remove-branch");
  if (!btn) return;
  if (branchesEditor.querySelectorAll(".branch-row").length <= 1) return;
  btn.closest(".branch-row").remove();
  refreshRemoveButtons();
});

function openDialogForNew() {
  dialogTitle.textContent = "新規テンプレート";
  fieldId.value = "";
  fieldTitle.value = "";
  fieldCategory.value = "";
  setBranchRows([{ id: uid(), label: "", content: "" }]);
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
  setBranchRows(t.branches);
  dialog.showModal();
  fieldTitle.focus();
}

form.addEventListener("submit", () => {
  const now = Date.now();
  const id = fieldId.value;
  const title = fieldTitle.value.trim();
  const category = fieldCategory.value.trim();

  const branches = [...branchesEditor.querySelectorAll(".branch-row")].map((row) => ({
    id: row.dataset.branchId,
    label: row.querySelector(".branch-label").value.trim(),
    content: row.querySelector(".branch-content").value,
  })).filter((b) => b.content.trim());

  if (!title || branches.length === 0) return;

  if (id) {
    const t = templates.find((x) => x.id === id);
    if (t) {
      t.title = title;
      t.category = category;
      t.branches = branches;
      t.updatedAt = now;
    }
  } else {
    templates.push({ id: uid(), title, category, branches, createdAt: now, updatedAt: now });
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
    selectedBranch.set(id, Number(target.dataset.idx));
    render();
  } else if (target.classList.contains("btn-copy")) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const branch = t.branches[currentBranchIndex(t)];
    try {
      await navigator.clipboard.writeText(branch.content);
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
      selectedBranch.delete(id);
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
      if (item.id && existingIds.has(item.id)) continue;
      const migrated = migrateTemplate(item);
      if (!migrated.branches.some((b) => b.content.trim())) continue;
      templates.push({
        id: item.id && !existingIds.has(item.id) ? item.id : uid(),
        title: item.title,
        category: typeof item.category === "string" ? item.category : "",
        branches: migrated.branches.map((b) => ({ id: b.id || uid(), label: b.label || "", content: b.content })),
        createdAt: item.createdAt || Date.now(),
        updatedAt: item.updatedAt || Date.now(),
      });
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
