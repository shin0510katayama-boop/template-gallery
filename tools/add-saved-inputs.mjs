// Add blank 一時保存 entries to a template, skipping names that already exist.
//   node tools/add-saved-inputs.mjs 指導報告書 --group 5講 "生徒A" "生徒B" --group 6講 "生徒C"
// `--group X` applies to the names after it (until the next --group); names before
// any --group get no group. Blank = every 〔入力欄〕 at its default and every 【分岐】 on
// its first option, the same state the app starts a new entry from.
// If a name already exists without a group, it is given the group instead of a
// duplicate. Works on ./templates.json (run it inside the sync-cli work dir), then `sync-cli.mjs push`.
import fs from "node:fs";
import crypto from "node:crypto";

const [title, ...args] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync("templates.json", "utf8"));
const t = d.templates.find((x) => x.title === title);
if (!t) { console.error(`template not found: ${title}`); process.exit(1); }

const added = [];
const grouped = [];
let group = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--group") { group = (args[++i] || "").trim(); continue; }
  const name = args[i];
  const existing = t.savedInputs.find((s) => s.name === name);
  if (existing) {
    if (group && !existing.group) { existing.group = group; grouped.push(`${name}→${group}`); }
    continue;
  }
  const values = Object.fromEntries(t.fields.map((f) => [f.id, f.default || ""]));
  const selections = Object.fromEntries(t.slots.map((s) => [s.id, s.options[0]?.id]));
  const entry = { id: crypto.randomUUID(), name, values, selections, savedAt: Date.now() };
  if (group) entry.group = group;
  t.savedInputs.push(entry);
  added.push(group ? `${group} ${name}` : name);
}
fs.writeFileSync("templates.json", JSON.stringify(d, null, 2) + "\n");
console.log(`added: ${added.join(", ") || "-"}${grouped.length ? `\ngrouped: ${grouped.join(", ")}` : ""}`);
