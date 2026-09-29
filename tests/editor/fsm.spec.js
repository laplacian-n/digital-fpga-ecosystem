// FSM designer: a state diagram written in a few lines becomes a checked D-FF circuit.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

test("Moore, Mealy and input-less FSMs build and pass their clock-by-clock check against the diagram", async ({ page }) => {
  test.setTimeout(120000);
  await openEditor(page);
  const r = await page.evaluate(() => {
    const out = {};
    const detect11 = MCP_OPS.build_fsm({ fsm: FSM_EXAMPLE, sheet: "det11" });
    out.detect = { states: detect11.states, ff: detect11.flip_flops, enc: detect11.encoding, pass: detect11.verified.pass, ports: detect11.ports.map(p => p.name) };
    // run it: x = 1,1,1,0,1,1 → z (Moore, one clock later) = 0,0,1,1,0,0,1
    const s = activeSch(), xs = [1, 1, 1, 0, 1, 1, 0], xId = s.components.find(c => c.type === "IN" && c.params.name === "x").id;
    const j = clientSeqSim(s, 7, { holdAt: i => ({ [xId]: xs[i] }) }), zk = j.sequence.outputs.indexOf("z");
    out.z = j.sequence.rows.map(r => r[3][zk]).join("");
    const mealy = MCP_OPS.build_fsm({ sheet: "mealy01", fsm: "inputs: x\noutputs: z\nA -> B when ~x\nA -> A else\nB -> A when x / z=1\nB -> B else\nreset A" });
    out.mealy = [mealy.kind, mealy.verified.pass];
    // a traffic light: no inputs, three states, three lamps
    const tl = MCP_OPS.build_fsm({ sheet: "traffic", state_out: false, fsm: { outputs: ["r", "y", "g"], reset: "RED",
      states: [{ name: "RED", out: { r: 1 } }, { name: "GREEN", out: { g: 1 } }, { name: "YELLOW", out: { y: 1 } }],
      transitions: [{ from: "RED", to: "GREEN" }, { from: "GREEN", to: "YELLOW" }, { from: "YELLOW", to: "RED" }] } });
    out.tl = [tl.states, tl.ports.map(p => p.name).join(","), tl.verified.pass];
    let err = null; try { MCP_OPS.build_fsm({ fsm: "inputs: x\nS0 -> S1 when x &\nreset S0" }); } catch (e) { err = e.message; }
    out.err = err;
    // the diagram is the sheet's acceptance test
    const t = Object.values(state.project.schematics).find(x => x.name === "traffic");
    out.spec = specCheck(t).pass;
    t.components.find(c => c.type === "DFF").params.edge = "falling"; out.specBroken = specCheck(t).pass;
    return out;
  });
  expect(r.detect).toMatchObject({ states: 3, ff: 2, pass: true, ports: ["clk", "x", "z", "state1", "state0"] });
  expect(r.detect.enc[0]).toEqual({ state: "S0", code: "00" });
  expect(r.z).toBe("0011001");
  expect(r.mealy).toEqual(["mealy", true]);
  expect(r.tl).toEqual([3, "clk,r,y,g", true]);
  expect(r.err).toContain("เงื่อนไข");
  expect(r.spec).toBe(true);
  expect(r.specBroken).toBe(false);
});

test("Tools ▸ ออกแบบ FSM: the diagram draws as it is typed, and builds", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => runGenerator("fsm"));
  await expect(page.locator("#fsmPic svg circle")).toHaveCount(3);
  await expect(page.locator("#fsmMsg")).toContainText("3 state → 2 flip-flop · Moore");
  await page.screenshot({ path: test.info().outputPath("fsm-tool.png") });
  await page.fill("#fsmSheet", "seq11");
  await page.click("#fsmGo");
  await expect.poll(() => page.evaluate(() => activeSch().name)).toBe("seq11");
  expect(await page.evaluate(() => sheetVerified(activeSch()))).toBe(true);
  expect(page.errors).toEqual([]);
});
