/* ===== 35. Whole lab systems as parts: the top sheet of lab 6 assembled by code ===================
   Testing the in-app AI on lab 6 (Qwen3.5 4B, agent mode): it split the design into blocks and built
   each one well, then spent 250 s + 10 min and connected 2 wires — wiring a dozen blocks together is
   past what a 4B model can do. So the system is a part like any other: the verified blocks from the
   library (divider, edge detector, BCD validity, 2-digit counter, BCD comparator, 4-digit scanner)
   placed and wired by code, the glue (button sampled every tick, start/stop toggle, error inhibit,
   clear at yy) checked clock by clock against a model of the lab's rules — on a small divider, since
   2 500 000 clocks per count cannot be run one by one — and the EDGE pins mapped. */

const PARTS_SYS_BEFORE=new Set(Object.keys(PARTS));
/* the clock_divider part's own model: clk_out of a ÷N divider, one clock at a time */
function sysDivStep(N, s){
  const M=N%2?N:N/2, bits=Math.max(1,(M-1).toString(2).length), wrap=s.c===M-1;
  return {out:N%2?(s.c>>(bits-1))&1:s.t, c:wrap?0:s.c+1, t:N%2?0:(wrap?s.t^1:s.t)};
}
Object.assign(PARTS, {
  lab6_counter:{ label:"แลป 6: ตัวนับ 00–yy ทั้งระบบ (บอร์ด EDGE)", group:"ระบบทั้งแลป",
    desc:"yy_tens/yy_ones = ค่าสิ้นสุด yy จากสวิตช์ (SW7–4 / SW3–0, BCD) · btn = ปุ่มกลาง Start/Stop (toggle, กันเด้งด้วยการอ่านทุก tick) · นับขึ้นทีละ 1 ทุก tick (50 MHz ÷ tick = 20 Hz) วนกลับ 00 เมื่อถึง yy · err = yy ไม่ใช่ BCD หรือค่านับ > yy (หยุดนับ, กดปุ่มไม่มีผล) · a..g + an[3:0] ต่อจอ 7-seg 2 หลักขวา (สแกนด้วย 50 MHz ÷ scan) · running, tens, ones ออก LED · จับขาบอร์ดให้แล้ว",
    params:{tick:{min:2,max:2147483648,def:2500000}, scan:{min:2,max:2147483648,def:50000}},
    ports:()=>({in:{clk:1, btn:1, yy_tens:4, yy_ones:4}, out:{a:1,b:1,c:1,d:1,e:1,f:1,g:1, an:4, err:1, running:1, tens:4, ones:4}}),
    build:p=>{ const t=ptIntent("lab6_counter"), clk=t.IN("clk"), btn=t.IN("btn");
      const YT=[0,1,2,3].map(i=>t.IN("yy_tens"+i)), YO=[0,1,2,3].map(i=>t.IN("yy_ones"+i));
      // tick: one clock-wide pulse every `tick` clocks (divider → rising-edge detector)
      const dv=ptBlock(t, ptSub("clock_divider", {n:p.tick})); t.W(clk, dv+".clk_in");
      const ed=ptBlock(t, ptSub("edge_detector")); t.W(clk, ed+".clk"); t.W(dv+".clk_out", ed+".x");
      const tick=ed+".pulse";
      // the button, sampled on every tick (~50 ms: no bounce survives) → one press = one pulse
      const hold=d=>{ const f=t.X("DFF"), m=t.X("MUX",{params:{inputs:2}});
        t.W(f+".q", m+".d0"); t.W(d, m+".d1"); t.W(tick, m+".s0"); t.W(m+".y", f+".d"); t.W(clk, f+".clk"); return f; };
      const s0=hold(btn), s1=hold(s0+".q");
      const press=t.G("AND",[tick, s0+".q", s1+".qn"]);
      // yy must be BCD, and the count may not be past it
      const sv=ptSub("bcd_valid"), vt=ptBlock(t, sv), vo=ptBlock(t, sv);
      YT.forEach((x,i)=>t.W(x, vt+".d"+i)); YO.forEach((x,i)=>t.W(x, vo+".d"+i));
      const cnt=ptBlock(t, ptSub("bcd_counter_multi", {format:"00-99"})), cmp=ptBlock(t, ptSub("bcd2_compare"));
      for(let i=0;i<4;i++){ t.W(cnt+".tens"+i, cmp+".a_hi"+i); t.W(cnt+".ones"+i, cmp+".a_lo"+i); t.W(YT[i], cmp+".b_hi"+i); t.W(YO[i], cmp+".b_lo"+i); }
      const err=t.G("OR",[vt+".invalid", vo+".invalid", cmp+".gt"]), ok=t.G("NOT",[err]);
      // start/stop: a toggle flip-flop, ignored while there is an error
      const run=t.X("DFF"); t.W(clk, run+".clk"); t.W(t.G("XOR",[run+".q", t.G("AND",[press, ok])]), run+".d");
      const en=t.G("AND",[tick, run+".q", ok]);
      t.W(clk, cnt+".clk"); t.W(en, cnt+".en"); t.W(t.G("AND",[en, cmp+".eq"]), cnt+".clr");    // yy → 00
      // display: the two right-hand digits, the other two kept dark
      const sd=ptBlock(t, ptSub("clock_divider", {n:p.scan})); t.W(clk, sd+".clk_in");
      const disp=ptBlock(t, ptSub("seg7_mux4")); t.W(sd+".clk_out", disp+".clk");
      for(let i=0;i<4;i++){ t.W(cnt+".ones"+i, disp+".ones"+i); t.W(cnt+".tens"+i, disp+".tens"+i);
        t.W(t.X("GND"), disp+".hundreds"+i); t.W(t.X("GND"), disp+".thousands"+i); }
      for(const s of "abcdefg") t.OUT(s, disp+"."+s);
      t.OUT("an0", disp+".an0"); t.OUT("an1", disp+".an1"); t.OUT("an2", t.X("VCC")); t.OUT("an3", t.X("VCC"));
      t.OUT("err", err); t.OUT("running", run+".q");
      for(let i=0;i<4;i++){ t.OUT("tens"+i, cnt+".tens"+i); t.OUT("ones"+i, cnt+".ones"+i); }
      return t; },
    // EDGE board: SW7–4 = tens of yy, SW3–0 = ones, centre button, 7-seg, LED0 = err, LED1 = running, LED15–8 = count
    after:sch=>{ const pm={clk:"clk", btn:"pb:4", err:"led:0", running:"led:1"};
      for(let i=0;i<4;i++){ pm["yy_ones"+i]="sw:"+i; pm["yy_tens"+i]="sw:"+(4+i); pm["an"+i]="an:"+i; pm["ones"+i]="led:"+(8+i); pm["tens"+i]="led:"+(12+i); }
      for(const s of "abcdefg") pm[s]="seg:"+s;
      sch.pinmap=pm; },
    // the glue against the lab's rules; the display is the seg7_mux4 block, checked on its own sheet
    seq:p=>{ if(p.tick>8 || p.scan>8) return {small:{tick:4, scan:2}};
      const N=p.tick, cycles=150;
      const btnOn=i=>(i>=3&&i<13) || (i>=52&&i<60) || (i>=66&&i<74) || (i>=120&&i<128);
      const yy=i=>i<90?[0,3] : i<108?[0,12] : i<135?[0,1] : [2,0];
      return {cycles, init:{c:0,t:0,pT:0,s0:0,s1:0,run:0,cnt:0},
        drive:i=>({btn:btnOn(i)?1:0, yy_tens:yy(i)[0], yy_ones:yy(i)[1]}),
        step:(s,v)=>{ const d=sysDivStep(N, s), tick=d.out&&!s.pT?1:0;
          const T=Math.floor(s.cnt/10), O=s.cnt%10;
          const err=v.yy_tens>9 || v.yy_ones>9 || T*16+O > v.yy_tens*16+v.yy_ones ? 1 : 0;
          const press=tick && s.s0 && !s.s1, en=tick && s.run && !err;
          const eq=T===v.yy_tens && O===v.yy_ones;
          return {out:{err, running:s.run, tens:T, ones:O},
            state:{c:d.c, t:d.t, pT:d.out, s0:tick?v.btn:s.s0, s1:tick?s.s0:s.s1,
              run:s.run^(press && !err ? 1 : 0), cnt:en&&eq ? 0 : en ? (s.cnt+1)%100 : s.cnt}}; }}; } },
});
/* lab 7: the countdown timer mm.ss — asked for after it was built by hand over MCP (20 blocks, a lost bus
   port, an hour of wiring). Same pattern as lab 6: verified library blocks wired by code, the glue
   checked clock by clock against the lab's rules on small dividers. Rules (the lab sheet):
     SW15–12 / 11–8 / 7–4 / 3–0 = tens / ones of minutes, tens / ones of seconds (BCD), 00.00 … 99.59;
     SET loads the switches (and stops), START/STOP toggles counting, RESET clears to 00.00 (and stops);
     one second per tick, borrowing across minutes; at 00.00 it stops and LED time-up lights;
     LED error = a digit that is not BCD or seconds' tens > 5 (SET and START are refused meanwhile).
   Buttons are sampled every `btn` clocks (50 MHz ÷ 1 000 000 = 50 Hz: no bounce gets through). */
function lab7Model(p){
  const mods=CNT_FORMATS["99.59"].mods, M=mods.reduce((a,b)=>a*b,1);
  const dig=sw=>[0,1,2,3].map(k=>(sw>>(4*k))&15);              // sec_lo, sec_hi, min_lo, min_hi
  const bad=sw=>{ const d=dig(sw); return d[0]>9 || d[1]>5 || d[2]>9 || d[3]>9 ? 1 : 0; };
  return {mods, M, dig, bad};
}
Object.assign(PARTS, {
  lab7_countdown:{ label:"แลป 7: ตัวจับเวลาถอยหลัง mm.ss ทั้งระบบ (บอร์ด EDGE)", group:"ระบบทั้งแลป",
    desc:"sw[15:0] = เวลาเริ่ม (BCD: สิบนาที/หน่วยนาที/สิบวินาที/หน่วยวินาที, 00.00–99.59) · set = โหลดค่า (ปุ่มซ้าย J14) · startstop = เริ่ม/หยุด (ปุ่มบน J13) · reset = ล้างเป็น 00.00 (ปุ่มกลาง J12) · นับลงทีละวินาที (50 MHz ÷ tick) ยืมข้ามนาที หยุดที่ 00.00 · led_error = ค่าไม่ใช่ BCD หรือสิบวินาที > 5 · led_timeup = ถึง 00.00 · running · จอ 7-seg 4 หลักมีจุดคั่น mm.ss · จับขาบอร์ดให้แล้ว",
    params:{tick:{min:2,max:2147483648,def:50000000}, btn:{min:2,max:2147483648,def:1000000}, scan:{min:2,max:2147483648,def:50000},
      count_out:{bool:true,def:false}},
    ports:p=>({in:{clk:1, set:1, startstop:1, reset:1, sw:16},
      out:Object.assign({a:1,b:1,c:1,d:1,e:1,f:1,g:1, dp:1, an:4, led_error:1, led_timeup:1, running:1}, p.count_out?{sec_lo:4, sec_hi:4, min_lo:4, min_hi:4}:{})}),
    build:p=>{ const t=ptIntent("lab7_countdown"), clk=t.IN("clk"), bset=t.IN("set"), bss=t.IN("startstop"), brst=t.IN("reset");
      const SW=Array.from({length:16},(_,i)=>t.IN("sw"+i)), dig=k=>SW.slice(4*k, 4*k+4);
      // a one-clock pulse every n clocks: divider → rising-edge detector
      const pulse=n=>{ const dv=ptBlock(t, ptSub("clock_divider", {n})); t.W(clk, dv+".clk_in");
        const ed=ptBlock(t, ptSub("edge_detector")); t.W(clk, ed+".clk"); t.W(dv+".clk_out", ed+".x"); return ed+".pulse"; };
      const tick=pulse(p.tick), bt=pulse(p.btn);
      // a button sampled on bt, twice: one press = one pulse
      const hold=d=>{ const f=t.X("DFF"), m=t.X("MUX",{params:{inputs:2}});
        t.W(f+".q", m+".d0"); t.W(d, m+".d1"); t.W(bt, m+".s0"); t.W(m+".y", f+".d"); t.W(clk, f+".clk"); return f; };
      const press=b=>{ const s0=hold(b), s1=hold(s0+".q"); return t.G("AND",[bt, s0+".q", s1+".qn"]); };
      const setp=press(bset), ssp=press(bss), rstp=press(brst);
      // error: a digit that is not BCD, or seconds' tens past 5 (sw7, or sw6·sw5)
      const sv=ptSub("bcd_valid"), inv=[0,2,3].map(k=>{ const b=ptBlock(t, sv); dig(k).forEach((x,i)=>t.W(x, b+".d"+i)); return b+".invalid"; });
      const err=t.G("OR",[...inv, SW[7], t.G("AND",[SW[6], SW[5]])]), ok=t.G("NOT",[err]);
      // the counter 00.00 … 99.59, counting down, loaded from the switches
      const cnt=ptBlock(t, ptSub("bcd_counter_multi", {format:"99.59", down:true, load:true})), N=CNT_FORMATS["99.59"].names;
      N.forEach((n,k)=>dig(k).forEach((x,i)=>t.W(x, cnt+"."+n+"_d"+i)));
      const Q=N.flatMap(n=>[0,1,2,3].map(i=>cnt+"."+n+i));
      const o1=t.X("OR",{params:{inputs:8}}), o2=t.X("OR",{params:{inputs:8}});
      Q.slice(0,8).forEach(q=>t.W(q, o1)); Q.slice(8).forEach(q=>t.W(q, o2));
      const zero=t.G("NOR",[o1, o2]), nz=t.G("NOT",[zero]);
      // running: START/STOP toggles it (not while there is an error or at 00.00); SET, RESET and 00.00 stop it
      const run=t.X("DFF"); t.W(clk, run+".clk");
      t.W(t.G("AND",[t.G("XOR",[run+".q", t.G("AND",[ssp, ok, nz])]), t.G("NOT",[setp]), t.G("NOT",[rstp]), nz]), run+".d");
      t.W(clk, cnt+".clk"); t.W(t.G("AND",[tick, run+".q", nz]), cnt+".en"); t.W(rstp, cnt+".clr"); t.W(t.G("AND",[setp, ok]), cnt+".load");
      // display: mm.ss with the point after the minutes (the hundreds digit)
      const sd=ptBlock(t, ptSub("clock_divider", {n:p.scan})); t.W(clk, sd+".clk_in");
      const disp=ptBlock(t, ptSub("seg7_mux4", {dp:true})); t.W(sd+".clk_out", disp+".clk");
      ["ones","tens","hundreds","thousands"].forEach((d,k)=>{ for(let i=0;i<4;i++) t.W(cnt+"."+N[k]+i, disp+"."+d+i); });
      [0,0,1,0].forEach((v,i)=>t.W(t.X(v?"VCC":"GND"), disp+".dots"+i));
      for(const s of "abcdefg") t.OUT(s, disp+"."+s);
      t.OUT("dp", disp+".dp"); for(let i=0;i<4;i++) t.OUT("an"+i, disp+".an"+i);
      t.OUT("led_error", err); t.OUT("led_timeup", zero); t.OUT("running", run+".q");
      if(p.count_out) N.forEach(n=>{ for(let i=0;i<4;i++) t.OUT(n+i, cnt+"."+n+i); });
      return t; },
    // the lab 7 pin table: SET J14, START/STOP J13, RESET J12, SW15–0, LED error K12, LED time-up M12
    after:sch=>{ const pm={clk:"clk", set:"pb:2", startstop:"pb:0", reset:"pb:4", led_error:"led:0", led_timeup:"led:1", running:"led:2", dp:"seg:dp"};
      for(let i=0;i<16;i++) pm["sw"+i]="sw:"+i;
      for(let i=0;i<4;i++) pm["an"+i]="an:"+i;
      for(const s of "abcdefg") pm[s]="seg:"+s;
      sch.pinmap=pm; },
    seq:p=>{ if(p.tick>8 || p.btn>8 || p.scan>8 || !p.count_out) return {small:{tick:6, btn:2, scan:2, count_out:true}};
      const L=lab7Model(p), cycles=230;
      const swAt=i=>i<60?0x0101 : i<120?0x0003 : i<140?0x0075 : i<190?0x9959 : 0x000A;
      const on=(i,a)=>i>=a && i<a+5;
      const drive=i=>({sw:swAt(i), set:on(i,4)||on(i,62)||on(i,124)||on(i,144)?1:0,
        startstop:on(i,12)||on(i,50)||on(i,72)||on(i,110)||on(i,152)||on(i,200)?1:0, reset:on(i,175)?1:0});
      return {cycles, init:{c:0,t:0,pT:0, bc:0,bt:0,pB:0, s0:[0,0,0], s1:[0,0,0], run:0, cnt:0}, drive,
        step:(s,v)=>{ const d=sysDivStep(p.tick, s), tick=d.out&&!s.pT?1:0;
          const e=sysDivStep(p.btn, {c:s.bc, t:s.bt}), bt=e.out&&!s.pB?1:0;
          const B=[v.set, v.startstop, v.reset], pr=B.map((_,k)=>bt && s.s0[k] && !s.s1[k] ? 1 : 0);
          const err=L.bad(v.sw), zero=s.cnt===0, en=tick && s.run && !zero;
          const out={led_error:err, led_timeup:zero?1:0, running:s.run};
          CNT_FORMATS["99.59"].names.forEach((n,k)=>out[n]=ptDigitsOf(s.cnt, L.mods)[k]);
          const run=((s.run ^ (pr[1] && !err && !zero ? 1 : 0)) && !pr[0] && !pr[2] && !zero) ? 1 : 0;
          const cnt=pr[2] ? 0 : (pr[0] && !err) ? ptValueOf(L.dig(v.sw), L.mods) : en ? (s.cnt+L.M-1)%L.M : s.cnt;
          return {out, state:{c:d.c, t:d.t, pT:d.out, bc:e.c, bt:e.t, pB:e.out,
            s0:bt?B.slice():s.s0, s1:bt?s.s0.slice():s.s1, run, cnt}}; }}; } },
});
const PARTS_SYSTEMS=Object.keys(PARTS).filter(k=>!PARTS_SYS_BEFORE.has(k));

/* "ทำแลป 6", "digital counter 00-yy" → the whole system, from the agent and from build mode */
{
  const _pf=partFromMessage;
  partFromMessage=function(msg){
    // a sheet NAMED lab6 ("… ตั้งชื่อแผ่น lab6") is not a request for lab 6
    const t=" "+String(msg||"").toLowerCase().replace(/(?:ชีต|ชีท|แผ่น|sheet)\s*(?:ใหม่\s*)?(?:ชื่อ\s*)?(?:ว่า\s*)?[`"'“]?[a-z_][a-z0-9_]*/g, " ")+" ";
    if(/(lab|แลป|แล็บ|แลบ|ใบงาน(?:ที่)?)\s*-?\s*0?6(?![\d.])|00\s*[-–]\s*yy|digital\s*counter|ตัวนับดิจิ(ทั|ตอ)ล/.test(t)
       && !(typeof aiLooksLikeQuestion==="function" && aiLooksLikeQuestion(msg) && !/(ทำ|สร้าง|ต่อ|ประกอบ|build|make)/.test(t))){
      const sm=/(?:ชีต|ชีท|แผ่น|sheet)\s*(?:ใหม่\s*)?(?:ชื่อ\s*)?[`"'“]?([A-Za-z_][A-Za-z0-9_]*)/.exec(msg);
      return {kind:"lab6_counter", args:sm?{sheet:sm[1]}:{}, simple:true, named:[]};
    }
    if(/(lab|แลป|แล็บ|แลบ|ใบงาน(?:ที่)?)\s*-?\s*0?7(?![\d.])|count\s*-?\s*down\s*timer|ตัวจับเวลาถอยหลัง|นับเวลาถอยหลัง/.test(t)
       && !(typeof aiLooksLikeQuestion==="function" && aiLooksLikeQuestion(msg) && !/(ทำ|สร้าง|ต่อ|ประกอบ|build|make)/.test(t))){
      const sm=/(?:ชีต|ชีท|แผ่น|sheet)\s*(?:ใหม่\s*)?(?:ชื่อ\s*)?[`"'“]?([A-Za-z_][A-Za-z0-9_]*)/.exec(msg);
      return {kind:"lab7_countdown", args:sm?{sheet:sm[1]}:{}, simple:true, named:[]};
    }
    return _pf.apply(this, arguments);
  };
}
