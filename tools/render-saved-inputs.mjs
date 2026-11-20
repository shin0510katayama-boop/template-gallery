// Print the text each 一時保存 of a template would copy, as JSON.
//   node tools/render-saved-inputs.mjs 指導報告書 [--group 5講]
// Output: [{ name, group, filled, text }, ...]. `filled` is false while every 〔入力欄〕
// is still at its default (the blank entry add-saved-inputs.mjs makes), so callers can
// skip entries nobody has written yet.
// Mirrors resolveSavedBody() in template-gallery/app.js — keep the two in step.
import fs from "node:fs";

const BRACKET_RE = /【([^【】]*)】/g;
const FIELD_RE = /〔([^〔〕]*)〕/g;

const [title, ...args] = process.argv.slice(2);
const gi = args.indexOf("--group");
const onlyGroup = gi >= 0 ? (args[gi + 1] || "").trim() : null;

const d = JSON.parse(fs.readFileSync("templates.json", "utf8"));
const t = d.templates.find((x) => x.title === title);
if (!t) { console.error(`template not found: ${title}`); process.exit(1); }

const same = (a, b) => (a || "").trim() === (b || "").trim();
function resolve(snap) {
  const withSlots = t.body.replace(BRACKET_RE, (match, label) => {
    const slot = t.slots.find((s) => same(s.label, label));
    if (!slot || slot.options.length === 0) return match;
    const opt = slot.options.find((o) => o.id === (snap.selections || {})[slot.id]) || slot.options[0];
    return opt ? opt.text : match;
  });
  return withSlots.replace(FIELD_RE, (match, label) => {
    const field = t.fields.find((f) => same(f.label, label));
    if (!field) return match;
    const v = (snap.values || {})[field.id];
    return v !== undefined ? v : (field.default || "");
  });
}

const out = t.savedInputs
  .filter((s) => onlyGroup === null || same(s.group, onlyGroup))
  .map((s) => ({
    name: s.name,
    group: s.group || "",
    filled: t.fields.some((f) => ((s.values || {})[f.id] ?? "") !== (f.default || "")),
    text: resolve(s),
  }));
console.log(JSON.stringify(out, null, 2));
