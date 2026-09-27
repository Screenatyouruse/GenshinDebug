// yve_probe_v6.js — WHERE do tap attempts die?
//
// v5 (yve_poc.js MODE=probe) already proved:
//   - the tap EXECUTES via the receive path: BattleReceiveMessage.Oper_On_CastSkill
//     (caller of MakeSrcSpellOut = libcsharp+0x2e21858) -> the cast is op-driven.
//   - CheckCastCond returns 0 for the tap = PASS (the caller then runs CheckCastCond_2,
//     also 0). It is NOT the gate.
//   - IsCasting is never called (0 hits in 40s) -> not the gate.
//   - MisconductCastSkill fires on every normal cast -> it is not a tripwire.
//
// This probe instruments the whole op pipeline and counts hits per layer, so one
// mashing session tells us which stage refuses the fast taps:
//
//   UI input        VirtualButton.CastSkill / SkillComponent.CastPosSkill
//   op build+send   BattleReceiveMessage.NewSendSkillBattleOperData
//   resend/ack      PeriodResendManager.skill_sending / .skill_after_sending /
//                   .on_battle_self_cast_skill   (self-cast confirm = ack)
//   receive+exec    on_OperType_Battle_CastSkill_Opt / Oper_On_CastSkill
//
// READ THE [stats] LINES (every 4s):
//   If ui/op counters advance at TAP rate but recv advances at FLOOR rate  -> the
//     drop is after the send (server/echo pacing or the op is never echoed).
//   If ui/op counters also advance at FLOOR rate even though you mash          -> the
//     local input/send gate is upstream (button/state machine/period-resend latch).
//   If only some layers advance, the first layer that stops growing is the gate.
//
// run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l yve_probe_v6.js --runtime qjs -q
// practice -> Yve -> ult -> MASH the tap ~10s, pause ~5s, mash ~10s. Paste it all back.

const TAP_ID = 10112;
const ULT_ID = 10130;
const YVE_IDS = [10110, 10112, 10120, 10130, 10135, 10136, 10161, 10173, 10180];

const RV = {
    // base anchor
    ctor: 0x5021200, GetOwner: 0x50211f8,
    // execution (recv side)
    MakeSrcSpellOut: 0x5024af4, MakeSonSpell: 0x5029d38,
    CheckCastCond: 0x50231c8, CheckCastCond2: 0x5024660,
    IsCasting: 0x50333fc, Misconduct: 0x502688c,
    Oper_On_CastSkill: 0x2e212c4,
    on_OperType_Battle_CastSkill_Opt: 0x2e21d58,
    NewSendSkillBattleOperData: 0x2e38f14,
    // ui / input
    VirtualButton_CastSkill: 0x3a07e20,
    SkillComp_CastPosSkill: 0x3aaafa0,
    SkillComp_UpdateKeepCastSkill: 0x3aaa52c,
    SkillComp_CastSpellToPos: 0x3aaa568,
    SkillComp_CastSpellToEnemy: 0x3aaaa20,
    // resend / ack
    PRM_instance: 0x45a9594,
    PRM_skill_sending: 0x45a9670,
    PRM_skill_after_sending: 0x45a9748,
    PRM_on_battle_self_cast_skill: 0x45a9b00,
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
function log(m) { console.log("[yve6] " + m); }
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
function u32(p, off) { try { return p.add(off).readU32(); } catch (e) { return 0; } }
function u64s(p, off) { try { return p.add(off).readU64().toString(); } catch (e) { return "0"; } }
function spellIdOf(p) {   // SpellCastData-ish: try +0x14 then +0x10
    if (!p || p.isNull() || p.toUInt32() < 0x1000) return 0;
    const a = u32(p, 0x14);
    if (a > 10000 && a < 999999) return a;
    const b = u32(p, 0x10);
    if (b > 10000 && b < 999999) return b;
    return 0;
}

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

// ---------------------------------------------------------------- counters + stats
const C = {};
function hit(name, n) { C[name] = (C[name] || 0) + (n || 1); }
const CAP = {};
function logcap(key, limit, line) {
    CAP[key] = (CAP[key] || 0) + 1;
    if (CAP[key] <= limit) log(line);
    else if (CAP[key] === limit + 1) log("[cap] " + key + " suppressed");
}

// ---------------------------------------------------------------- cast pipeline probes
function hook(name, rva, fn) {
    try {
        Interceptor.attach(BASE.add(rva), fn);
        log("[hook] " + name + " @" + BASE.add(rva));
    } catch (e) { log("[!] hook " + name + ": " + e); }
}

// --- UI input
hook("VirtualButton.CastSkill", RV.VirtualButton_CastSkill, {
    onEnter(args) { const id = args[1].toInt32(); hit("ui.vbutton"); logcap("ui.vbutton", 40, "ui VirtualButton.CastSkill id=" + id); },
});
hook("SkillComponent.CastPosSkill", RV.SkillComp_CastPosSkill, {
    onEnter(args) { hit("ui.castpos"); logcap("ui.castpos", 40, "ui SkillComponent.CastPosSkill a1=" + args[1] + " a2=" + args[2] + " a3=" + args[3]); },
});
hook("SkillComponent.UpdateKeepCastSkill", RV.SkillComp_UpdateKeepCastSkill, {
    onEnter() { hit("ui.keepcast"); },
});

// --- op build / send
hook("NewSendSkillBattleOperData", RV.NewSendSkillBattleOperData, {
    onEnter(args) {
        hit("net.newsend");
        const id = spellIdOf(args[1]);
        logcap("net.newsend", 60, "net NewSendSkillBattleOperData op=" + args[1] + " id?=" + id);
    },
});

// --- resend / ack machinery
hook("PRM.skill_sending", RV.PRM_skill_sending, {
    onEnter(args) { hit("prm.sending"); logcap("prm.sending", 40, "prm skill_sending id=" + args[0].toInt32()); },
    onLeave(ret) { logcap("prm.sending:ret", 40, "prm skill_sending -> " + ret); },
});
hook("PRM.skill_after_sending", RV.PRM_skill_after_sending, {
    onEnter(args) { hit("prm.after"); logcap("prm.after", 40, "prm skill_after_sending a1=" + args[0] + " id=" + args[1].toInt32()); },
});
hook("PRM.on_battle_self_cast_skill", RV.PRM_on_battle_self_cast_skill, {
    onEnter(args) {
        hit("prm.selfcast");
        const op = args[4];
        const id = spellIdOf(op);
        logcap("prm.selfcast", 40, "prm self_cast_skill op=" + op + " id?=" + id + " (+0x10=" + (op && !op.isNull() ? u32(op, 0x10) : "?") + ")");
    },
});

// --- receive / execute
hook("on_OperType_Battle_CastSkill_Opt", RV.on_OperType_Battle_CastSkill_Opt, {
    onEnter(args) { hit("recv.oper"); logcap("recv.oper", 30, "recv on_OperType.CastSkill a1=" + args[1] + " a2=" + args[2] + " a3=" + args[3]); },
});
hook("Oper_On_CastSkill", RV.Oper_On_CastSkill, {
    onEnter(args) { hit("recv.exec"); logcap("recv.exec", 20, "recv Oper_On_CastSkill this=" + args[0] + " a1=" + args[1]); },
});

// --- execution delta (the floor) + caller attribution of the per-tap CheckCastCond
const lastAt = {};
hook("MakeSrcSpellOut", RV.MakeSrcSpellOut, {
    onEnter(args) {
        hit("exec.makesrc");
        this.sc = args[1];
    },
    onLeave() {
        const sc = this.sc;
        if (!sc || sc.isNull() || sc.toUInt32() < 0x1000) return;
        const id = spellIdOf(sc);
        if (!id) return;
        const now = Date.now();
        let d = "";
        if (lastAt[id]) d = " d=+" + (now - lastAt[id]) + "ms";
        lastAt[id] = now;
        if (id === TAP_ID || id === ULT_ID) {
            hit("exec." + id);
            logcap("exec.tap", 200, "[cast] spell=" + id + " owner=" + u32(sc, 0x20) + d);
        }
    },
});

hook("CheckCastCond", RV.CheckCastCond, {
    onEnter(args) {
        this.sc = args[1];
        this.id = spellIdOf(args[1]);
        this.from = null;
        if (this.id === TAP_ID || this.id === ULT_ID) {
            try { this.from = sym(this.returnAddress); } catch (e) { /* */ }
        }
    },
    onLeave(ret) {
        if (this.id !== TAP_ID && this.id !== ULT_ID) return;
        logcap("cc:" + this.id, 60, "cc id=" + this.id + " ret=" + ret.toInt32() + " <- " + this.from);
    },
});

// ---------------------------------------------------------------- stats
setInterval(() => {
    const keys = Object.keys(C).sort();
    const parts = keys.map((k) => k + "=" + C[k]);
    log("[stats] " + parts.join(" "));
}, 4000);

log("[*] v6 armed. MASH the tap ~10s / pause 5s / mash ~10s. The [stats] deltas are the answer.");
log("[*] reading: ui+net growing at tap rate but exec at floor rate => drop is after send;");
log("[*]          ui+net also at floor rate => local send/input latch (step-2 PoC target).");
