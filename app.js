const STORAGE_KEY = "templateCopier.templates.v1";

/** @typedef {{id:string,title:string,category:string,content:string,createdAt:number,updatedAt:number}} Template */

/** @type {Template[]} */
let templates = loadTemplates();

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
const fieldContent = document.getElementById("field-content");

const toast = document.getElementById("toast");

function loadTemplates() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
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

function render() {
  renderCategoryOptions();

  const query = searchInput.value.trim().toLowerCase();
  const category = categoryFilter.value;

  const filtered = templates
    .filter((t) => !category || t.category === category)
    .filter((t) => !query || t.title.toLowerCase().includes(query) || t.content.toLowerCase().includes(query))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  emptyState.hidden = templates.length > 0;
  grid.hidden = templates.length === 0;

  grid.innerHTML = filtered.map((t) => `
    <article class="template-card" data-id="${t.id}">
      <div class="card-top">
        <h3 class="card-title">${escapeHtml(t.title)}</h3>
      </div>
      ${t.category ? `<span class="card-category">${escapeHtml(t.category)}</span>` : ""}
      <p class="card-preview">${escapeHtml(t.content)}</p>
      <div class="card-actions">
        <button class="btn btn-primary btn-copy" data-id="${t.id}">コピー</button>
        <button class="btn btn-ghost btn-edit" data-id="${t.id}">編集</button>
        <button class="btn btn-ghost btn-danger btn-delete" data-id="${t.id}">削除</button>
      </div>
    </article>
  `).join("");
}

function openDialogForNew() {
  dialogTitle.textContent = "新規テンプレート";
  fieldId.value = "";
  fieldTitle.value = "";
  fieldCategory.value = "";
  fieldContent.value = "";
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
  fieldContent.value = t.content;
  dialog.showModal();
  fieldTitle.focus();
}

form.addEventListener("submit", (e) => {
  const now = Date.now();
  const id = fieldId.value;
  const title = fieldTitle.value.trim();
  const category = fieldCategory.value.trim();
  const content = fieldContent.value;

  if (!title || !content) return;

  if (id) {
    const t = templates.find((x) => x.id === id);
    if (t) {
      t.title = title;
      t.category = category;
      t.content = content;
      t.updatedAt = now;
    }
  } else {
    templates.push({ id: uid(), title, category, content, createdAt: now, updatedAt: now });
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

  if (target.classList.contains("btn-copy")) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t.content);
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
      if (!item || typeof item.title !== "string" || typeof item.content !== "string") continue;
      if (item.id && existingIds.has(item.id)) continue;
      templates.push({
        id: item.id && !existingIds.has(item.id) ? item.id : uid(),
        title: item.title,
        category: typeof item.category === "string" ? item.category : "",
        content: item.content,
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
