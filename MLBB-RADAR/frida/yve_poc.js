// yve_poc.js — Yve instant-tap: probe v5 + Step-2 PoC (state reset / gate lie).
//
// Background: m2/docs/YVE_TAP_ANALYSIS.md. Floor is ~450-530 ms, not CD/lock/ammo;
// the refusal happens UPSTREAM of MakeSrcSpellOut (v4 saw no calls during the floor).
//
// MODE (edit below):
//   "probe" — v5: caller of MakeSrcSpellOut, IsCasting traffic, CheckCastCond returns
//             (with caller attribution), MisconductCastSkill canary. The v5 run already
//             happened; yve_probe_v6.js supersedes it for the "where does it die" hunt.
//   "pocA"  — state reset: N ms after each tap cast, free the "previous cast alive" state
//             (null m_pCurSpell @+0x58, optionally busy @+0x80 / slot @+0x14).
//             THIS is the Step-2 attack.
//   "pocB"  — gate lie: force IsCasting() false. v5 says IsCasting is never called, so
//             expect nothing; kept only in case another path calls it.
//   "pocAB" — pocA + pocB.
//
// run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l yve_poc.js --runtime qjs -q
// practice -> Yve -> ult -> MASH the tap ~10s, then pause, then mash again.
//
// Paste back from "[yve] [base]" through the last "[cast]" line.
//
// IDA: libcsharp_global.so.i64, imagebase 0 -> RVA == file offset.
//   LogicSkillComp..ctor   0x5021200   GetOwner 0x50211f8
//   MakeSrcSpellOut        0x5024af4   MakeSonSpell 0x5029d38
//   CheckCastCond          0x50231c8   CheckCastCond_2 0x5024660
//   IsCasting              0x50333fc   MisconductCastSkill 0x502688c
//   RemoveSpellOrEffect    0x502967c   CancelSpell 0x502ed8c
//
// v5 log facts (probe run, 2026-09):
//   - tap executes via the RECEIVE path: BattleReceiveMessage.Oper_On_CastSkill
//     (caller of MakeSrcSpellOut = libcsharp+0x2e21858) -> op-driven cast.
//   - CheckCastCond returns 0 = PASS for both ult and tap (then CheckCastCond_2 runs,
//     also 0). So there is NOTHING to force there -> B_FORCE_CHECKCOND deleted.
//   - IsCasting: 0 calls in 40s -> not on this path (or inlined). Its lie is inert.
//   - MisconductCastSkill: fires once per NORMAL cast -> not a tripwire.
//   The Step-2 attack is therefore pocA (free the local state so the next tap is not
//   held), not pocB. Run yve_probe_v6.js first to confirm which layer refuses.

const MODE = "pocAB";

const CFG = {
    TAP_ID: 10112,                  // Yve tap strike
    ULT_ID: 10130,                  // Yve ult (stance)
    YVE_IDS: [10110, 10112, 10120, 10130, 10135, 10136, 10161, 10173, 10180],
    OWNER_ID: 0,                    // 0 = learn from the first tap cast (recommended)
    LOG_CAP: 120,

    // --- pocA
    A_DELAY_MS: 250,                // when to free the previous cast state (< vanilla floor)
    A_NULL_CURSPELL: true,          // comp+0x58 = 0
    A_NULL_BUSY: false,             // comp+0x80 = 0 (IsCasting's busy byte)
    A_NULL_SLOT: false,             // comp+0x14 = 0 (IsCasting's slot compare)
    A_CALL_REMOVE: false,           // call RemoveSpellOrEffect(comp, cur, 0, 0) — can desync FX

    // --- pocB (kept for completeness; IsCasting had 0 hits in the v5 probe)
    B_FORCE_ISCASTING: true,        // IsCasting -> false while a Yve spell is in play
};

const RV = {
    ctor: 0x5021200, GetOwner: 0x50211f8,
    MakeSrcSpellOut: 0x5024af4, MakeSonSpell: 0x5029d38,
    CheckCastCond: 0x50231c8, CheckCastCond2: 0x5024660,
    IsCasting: 0x50333fc, Misconduct: 0x502688c,
    RemoveSpellOrEffect: 0x502967c, CancelSpell: 0x502ed8c,
};

const lib = Process.getModuleByName("liblogic.so");
const E = (n, r, a) => new NativeFunction(lib.getExportByName(n), r, a);
const domainGet = E("il2cpp_domain_get", "pointer", []);
const threadAttach = E("il2cpp_thread_attach", "pointer", ["pointer"]);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const classGetMethods = E("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"]);
const methodGetName = E("il2cpp_method_get_name", "pointer", ["pointer"]);
const methodGetParamCount = E("il2cpp_method_get_param_count", "uint32", ["pointer"]);

function cstr(p) { return p.isNull() ? "" : p.readUtf8String(); }
function log(m) { console.log("[yve] " + m); }
function sym(a) {
    try {
        const m = Process.findModuleByAddress(a);
        if (m) return m.name + "+0x" + a.sub(m.base).toString(16);
    } catch (e) { /* */ }
    return a.toString();
}
function findKlass(ns, name) {
    const d = domainGet(); const sb = Memory.alloc(8);
    const asms = domainGetAssemblies(d, sb); const n = sb.readU64().toNumber();
    const mk = (s) => Memory.allocUtf8String(s);
    for (let i = 0; i < n; i++) {
        const img = assemblyGetImage(asms.add(i * Process.pointerSize).readPointer());
        if (img.isNull()) continue;
        const k = classFromName(img, mk(ns), mk(name));
        if (!k.isNull()) return k;
    }
    return null;
}
function methodAddr(klass, name, argc) {
    if (!klass) return null;
    const iter = Memory.alloc(8);
    let m = classGetMethods(klass, iter);
    while (!m.isNull()) {
        try { if (methodGetParamCount(m) === argc && cstr(methodGetName(m)) === name) return m.readPointer(); } catch (e) { /* */ }
        m = classGetMethods(klass, iter);
    }
    return null;
}

// ---------------------------------------------------------------- base
threadAttach(domainGet());
const K = findKlass("Battle", "LogicSkillComp");
if (!K) throw new Error("Battle.LogicSkillComp not found - in a match?");
const ctor = methodAddr(K, ".ctor", 0);
if (!ctor || ctor.isNull()) throw new Error("ctor not resolved");
const BASE = ctor.sub(RV.ctor);
log("[base] " + BASE + (BASE.and(ptr(0xfff)).isNull() ? " (aligned)" : " (!! NOT ALIGNED)"));
try {
    const b = new Uint8Array(BASE.add(RV.GetOwner).readByteArray(8));
    log("[base] GetOwner prologue " + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join(" "));
} catch (e) { log("[!] prologue read: " + e); }
try {
    const mod = Process.findModuleByAddress(BASE.add(RV.MakeSrcSpellOut));
    if (mod) log("[base] " + sym(BASE.add(RV.MakeSrcSpellOut)) + " (module " + mod.name + " @ " + mod.base + ")");
} catch (e) { /* */ }

// ---------------------------------------------------------------- state helpers
function compState(comp) {
    try {
        return {
            slot: comp.add(0x14).readU32(),                 // IsCasting's compare target
            busy: comp.add(0x80).readU8(),                  // IsCasting's busy byte
            cur: comp.add(0x58).readPointer(),              // m_pCurSpell
            owner: comp.add(0x60).readPointer(),            // m_pOwner (LogicFighter)
        };
    } catch (e) { return null; }
}
function curSpellId(st) {
    if (!st || !st.cur || st.cur.isNull() || st.cur.toUInt32() < 0x1000) return 0;
    try { return st.cur.add(0x14).readS32(); } catch (e) { return 0; }
}
function scId(sc) {
    if (!sc || sc.isNull() || sc.toUInt32() < 0x1000) return 0;
    try { return sc.add(0x14).readS32(); } catch (e) { return 0; }
}
function scOwner(sc) {
    try { return sc.add(0x20).readU32(); } catch (e) { return 0; }
}
function isYve(id) { return CFG.YVE_IDS.indexOf(id) >= 0; }
function ownerOk(owner) { return !CFG.OWNER_ID || owner === CFG.OWNER_ID; }

const counters = { isCastCalls: 0, isCastForced: 0, ccCalls: 0, ccForced: 0, resets: 0, canary: 0 };
function allow(key, limit) {
    counters[key] = (counters[key] || 0) + 1;
    if (counters[key] <= limit) return true;
    if (counters[key] === limit + 1) log("[cap] " + key + " suppressed");
    return false;
}

function castLine(sc) {
    try {
        return "spell=" + scId(sc) + " owner=" + scOwner(sc) +
            " srcGuId=" + sc.add(0x2c).readU32() + " srcSpell=" + sc.add(0x34).readS32() +
            " pos=(" + (Math.round(sc.add(0x40).readDouble() * 10) / 10) + "," +
            (Math.round(sc.add(0x48).readDouble() * 10) / 10) + ")";
    } catch (e) { return null; }
}

// ---------------------------------------------------------------- MakeSrcSpellOut: delta + caller + pocA
const lastAt = {};
let callersLogged = 0;

Interceptor.attach(BASE.add(RV.MakeSrcSpellOut), {
    onEnter(args) {
        this.comp = args[0];
        this.sc = args[1];
        if (MODE === "probe" && callersLogged < 24) {
            callersLogged++;
            log("[caller] MakeSrcSpellOut <- " + sym(this.returnAddress) +
                "  (spell=" + scId(args[1]) + ")");
        }
        if (CFG.OWNER_ID === 0 && scId(args[1]) === CFG.TAP_ID) {
            const o = scOwner(args[1]);
            if (o) { CFG.OWNER_ID = o; log("[owner] learned owner id = " + o); }
        }
    },
    onLeave() {
        const sc = this.sc, comp = this.comp;
        if (!sc || sc.isNull() || sc.toUInt32() < 0x1000) return;
        const id = scId(sc);
        if (!id) return;
        const now = Date.now();
        let d = "";
        if (lastAt[id]) d = " d=+" + (now - lastAt[id]) + "ms";
        lastAt[id] = now;
        if (allow("cast:" + id, CFG.LOG_CAP)) log("[cast] " + castLine(sc) + d);

        // pocA: schedule freeing the cast state so the NEXT tap is not held by it
        if ((MODE === "pocA" || MODE === "pocAB") && id === CFG.TAP_ID) {
            const st = compState(comp);
            const cur = st ? st.cur : ptr(0);
            setTimeout(() => freeCastState(comp, cur, id), CFG.A_DELAY_MS);
        }
    },
});

// RemoveSpellOrEffect is a native call, safe to invoke from the game thread (we are on it).
let removeFn = null;
if (CFG.A_CALL_REMOVE) {
    try { removeFn = new NativeFunction(BASE.add(RV.RemoveSpellOrEffect), "void", ["pointer", "pointer", "int", "int"]); }
    catch (e) { log("[!] RemoveSpellOrEffect fn: " + e); }
}
function freeCastState(comp, cur, id) {
    try {
        const st = compState(comp);
        if (!st) return;
        let did = [];
        if (CFG.A_CALL_REMOVE && removeFn && cur && !cur.isNull()) {
            removeFn(comp, cur, 0, 0);
            did.push("RemoveSpellOrEffect");
        }
        if (CFG.A_NULL_CURSPELL && !st.cur.isNull()) { comp.add(0x58).writePointer(ptr(0)); did.push("cur=0"); }
        if (CFG.A_NULL_BUSY && st.busy) { comp.add(0x80).writeU8(0); did.push("busy=0"); }
        if (CFG.A_NULL_SLOT && st.slot) { comp.add(0x14).writeU32(0); did.push("slot=0"); }
        if (did.length) {
            counters.resets++;
            if (allow("reset", CFG.LOG_CAP))
                log("[pocA] freed " + CFG.A_DELAY_MS + "ms after tap " + id + ": " + did.join(","));
        }
    } catch (e) { if (allow("reset-err", 5)) log("[!] reset: " + e); }
}

// ---------------------------------------------------------------- IsCasting: probe + pocB
Interceptor.attach(BASE.add(RV.IsCasting), {
    onEnter(args) {
        this.comp = args[0];
        this.want = args[1].toInt32();
    },
    onLeave(ret) {
        counters.isCastCalls++;
        const comp = this.comp, want = this.want;
        if (!comp || comp.isNull()) return;
        const st = compState(comp);
        const curId = curSpellId(st);
        const retTrue = (ret.toUInt32() & 1) !== 0;
        const yveInPlay = isYve(want) || isYve(curId) || (st && isYve(st.slot));

        if (MODE === "probe") {
            if ((retTrue || curId) && allow("IsCasting", CFG.LOG_CAP))
                log("[IsCasting] want=" + want + " ret=" + (retTrue ? 1 : 0) +
                    " slot=" + (st ? st.slot : "?") + " busy=" + (st ? st.busy : "?") +
                    " cur=" + curId + " owner=" + (st && !st.owner.isNull() ? st.owner : "null"));
        }

        if (CFG.B_FORCE_ISCASTING && (MODE === "pocB" || MODE === "pocAB") && retTrue && yveInPlay) {
            const owner = (st && !st.owner.isNull()) ? st.owner : null;
            ret.replace(ptr(0));
            counters.isCastForced++;
            if (allow("IsCasting:forced", CFG.LOG_CAP))
                log("[pocB] IsCasting(" + want + ") lied false  cur=" + curId +
                    " slot=" + (st ? st.slot : "?") + " owner=" + owner);
        }
    },
});

// ---------------------------------------------------------------- CheckCastCond: probe + pocB
function hookCheckCastCond(tag, rva, isSecond) {
    try {
        Interceptor.attach(BASE.add(rva), {
            onEnter(args) {
                this.sc = args[1];
                this.id = scId(args[1]);
                this.owner = scOwner(args[1]);
                this.from = null;
                if (this.id === CFG.TAP_ID || this.id === CFG.ULT_ID) {
                    try { this.from = sym(this.returnAddress); } catch (e) { /* */ }
                }
            },
            onLeave(ret) {
                counters.ccCalls++;
                const id = this.id, r = ret.toInt32();
                if (id !== CFG.TAP_ID && id !== CFG.ULT_ID) return;
                if (allow(tag, CFG.LOG_CAP))
                    log("[" + tag + "] id=" + id + " ret=" + r + " owner=" + this.owner +
                        " <- " + (this.from || "?"));
            },
        });
        log("[hook] " + tag + " @" + BASE.add(rva) + (isSecond ? " (secondary)" : ""));
    } catch (e) { log("[!] hook " + tag + ": " + e); }
}
hookCheckCastCond("CheckCastCond", RV.CheckCastCond, false);
hookCheckCastCond("CheckCastCond_2", RV.CheckCastCond2, true);

// ---------------------------------------------------------------- canary + summary
try {
    Interceptor.attach(BASE.add(RV.Misconduct), {
        onEnter(args) {
            counters.canary++;
            log("[CANARY] MisconductCastSkill called  arg0=" + args[0] + " arg1=" + args[1] +
                " arg2=" + args[2] + " (client self-report of an abnormal cast)");
        },
    });
    log("[hook] MisconductCastSkill @" + BASE.add(RV.Misconduct));
} catch (e) { log("[!] hook MisconductCastSkill: " + e); }

setInterval(() => {
    log("[stats] IsCasting calls=" + counters.isCastCalls + " forced=" + counters.isCastForced +
        " | CheckCastCond calls=" + counters.ccCalls + " forced=" + counters.ccForced +
        " | resets=" + counters.resets + " | canary=" + counters.canary);
}, 5000);

log("[*] armed  MODE=" + MODE + "  owner=" + (CFG.OWNER_ID || "learn") +
    "  tap=" + CFG.TAP_ID + "  aDelay=" + CFG.A_DELAY_MS + "ms");
log("[*] ult first, then MASH the tap ~10s, pause ~5s, mash again. Paste the whole log back.");
