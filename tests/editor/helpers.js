// Shared helpers: open the editor straight from disk in a fresh profile.
const path = require("path");
const { pathToFileURL } = require("url");
const EDITOR = pathToFileURL(path.join(__dirname, "..", "..", "schematic&bus2vhdl.html")).href;

/** Open the editor; `keepWelcome` leaves the first-run welcome dialog up. */
async function openEditor(page, { keepWelcome = false } = {}) {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(m.text()); });
  await page.goto(EDITOR);
  await page.waitForFunction(() => typeof UX === "object" && typeof activeSch === "function");
  await page.waitForTimeout(700);                       // welcome opens after 500 ms
  if (!keepWelcome) await page.evaluate(() => document.querySelectorAll(".modal-bg").forEach(m => m.remove()));
  page.errors = errors;
  return page;
}

/** Replace the active sheet with parts/wires. parts: [{k, type, x, y, params}], wires: [[k, pin, k, pin]] */
async function drawSheet(page, parts, wires = []) {
  await page.evaluate(({ parts, wires }) => {
    const s = activeSch(); s.components = []; s.wires = []; const id = {};
    parts.forEach(p => { const c = { id: uid("c"), type: p.type, x: p.x, y: p.y, label: "",
      params: Object.assign(JSON.parse(JSON.stringify((TYPES[p.type] && TYPES[p.type].defaultParams) || {})), p.params || {}) };
      s.components.push(c); id[p.k] = c; });
    wires.forEach(([a, ap, b, bp]) => {
      const inPin = bp === "in0" || bp === "in1" ? getPorts(id[b]).filter(q => q.dir === "in")[+bp.slice(2)].id : bp;
      s.wires.push({ id: uid("w"), from: { cid: id[a].id, pid: ap }, to: { cid: id[b].id, pid: inPin }, width: 1 });
    });
    autoRouteSheet(s); snapshot(); renderAll();
  }, { parts, wires });
}

module.exports = { EDITOR, openEditor, drawSheet };
