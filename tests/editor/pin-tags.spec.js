// Board pins drawn under the ports once pins are chosen (red when missing / shared); get_events waits for the next edit.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("pin tags on the canvas: assigned, missing, shared; get_events {wait}", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    await MCP_OPS.build_circuit({ name: "g", formula: "y = a & b; z = a | b" });
    const none = document.querySelectorAll(".pin-tags .pin-tag").length;         // no pins chosen yet: nothing drawn
    MCP_OPS.set_pins({ sheet: "g", map: { a: "sw:0", b: "sw:0", y: "led:0" } });
    render();
    const off = document.querySelectorAll(".pin-tags .pin-tag").length;          // off by default: the drawing stays clean
    localStorage.setItem("schstudio.pinTags", "1"); render();
    const tags = [...document.querySelectorAll(".pin-tags .pin-tag")].map(t => ({ text: t.childNodes[0].textContent, bad: t.classList.contains("bad") }));
    // an edit arrives while get_events waits
    const since = (await MCP_OPS.get_events({})).latest;
    setTimeout(() => { const s = activeSch(); s.components.push({ id: uid("c"), type: "NOT", x: 900, y: 500, params: JSON.parse(JSON.stringify(TYPES.NOT.defaultParams || {})), label: "" }); snapshot(); }, 600);
    const t0 = performance.now(), ev = await MCP_OPS.get_events({ since, wait: 5 });
    localStorage.removeItem("schstudio.pinTags");
    return { none, off, tags, waited: performance.now() - t0, got: ev.events.map(e => e.kind) };
  });
  expect(r.none).toBe(0);
  expect(r.off).toBe(0);
  expect(r.tags).toEqual(expect.arrayContaining([{ text: "SW0 ⚠ ซ้ำ", bad: true }, { text: "LED0", bad: false }, { text: "ยังไม่มีขา", bad: true }]));
  expect(r.waited).toBeGreaterThan(400);
  expect(r.got).toContain("user_edit");
});
