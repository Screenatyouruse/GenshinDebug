// yve_probe_v7.js — ATTEMPTS vs ACCEPTED: where does the fast tap get refused?
//
// v6 result (tap pipeline, one clean instance per accepted tap):
//   ui taps -> LogicBattleData.ILOGIC_TryUseSkill  (cc id=10112 <- 0x358916c)
//           -> NewSendSkillBattleOperData           (op built + sent)
//           -> prm skill_after_sending
//           -> recv Oper_On_CastSkill -> MakeSrcSpellOut -> [cast]  (echo executes)
//   net.newsend == recv.exec == exec count, and NO orphan sends -> refusals happen
//   BEFORE the op is built. VirtualButton/SkillComponent/SkillComponent.UpdateKeepCast
//   hooks never fired, so the tap input arrives via the UIKeySkill layer instead.
//
// This probe answers the one remaining question:
//   during the ~500ms floor, does ILOGIC_TryUseSkill still get called per mash tap
//   (local refusal with a code -> we patch that code path)
//   or does it only get called at floor rate (input never reaches it -> the lock is
//   in the UIKeySkill / touch layer, upstream).
//
// IDA (libcsharp, imagebase 0):
//   LogicBattleData.ILOGIC_TryUseSkill   0x3588f90  (calls CheckCastCond @0x358916c,
//       returns int status; 0 / -72 = accepted-ish, -79 = no ShowSkillData,
//       -97 = locked/handled, -82 = null operator)
//   callers: UIKeySkill.OnDragSkillFor122 0x34bdf0c, UIKeySkill.TrackSkillCastResult
//            0x34c0634, UIKeySkill.OnDragSkillForceDir 0x34e3ed0,
//            KeySkillContinuous.CanUseSkill 0x3f93db0, AI TryUseSkill (ignore)
//
// run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l yve_probe_v7.js --runtime qjs -q
// practice -> Yve -> ult -> MASH ~10s, pause ~5s, MASH ~10s. Paste the [stats] + [try] lines.

const YVE_IDS = [10110, 10112, 10120, 10130, 10135, 10136, 10161, 10173, 10180];
const TAP_ID = 10112;

const RV = {
    ctor: 0x5021200, GetOwner: 0x50211f8,
    MakeSrcSpellOut: 0x5024af4,
    ILOGIC_TryUseSkill: 0x3588f90,
    UIKey_OnDragSkillFor122: 0x34bdf0c,
    UIKey_OnDragSkillForceDir: 0x34e3ed0,
    UIKey_TrackSkillCastResult: 0x34c0634,
    KeySkillContinuous_CanUseSkill: 0x3f93db0,
    NewSendSkillBattleOperData: 0x2e38f14,
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
function log(m) { console.log("[yve7] " + m); }
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

threadAttach(domainGet());
const K = findKlass("Battle", "LogicSkillComp");
if (!K) throw new Error("Battle.LogicSkillComp not found - in a match?");
const ctor = methodAddr(K, ".ctor", 0);
if (!ctor || ctor.isNull()) throw new Error("ctor not resolved");
const BASE = ctor.sub(RV.ctor);
log("[base] " + BASE + (BASE.and(ptr(0xfff)).isNull() ? " (aligned)" : " (!! NOT ALIGNED)"));

const C = {};
function hit(name, n) { C[name] = (C[name] || 0) + (n || 1); }
const CAP = {};
function logcap(key, limit, line) {
    CAP[key] = (CAP[key] || 0) + 1;
    if (CAP[key] <= limit) log(line);
    else if (CAP[key] === limit + 1) log("[cap] " + key + " suppressed");
}
function hook(name, rva, fn) {
    try {
        Interceptor.attach(BASE.add(rva), fn);
        log("[hook] " + name);
    } catch (e) { log("[!] hook " + name + ": " + e); }
}

// ---------------------------------------------------------------- THE money hook
hook("ILOGIC_TryUseSkill", RV.ILOGIC_TryUseSkill, {
    onEnter(args) {
        this.self = args[0];
        this.op = args[1];
        this.id = args[2].toInt32();
        this.a4 = args[3].toInt32();
        this.a5 = args[4].toInt32();
        this.from = null;
        if (YVE_IDS.indexOf(this.id) >= 0) {
            try { this.from = sym(this.returnAddress); } catch (e) { /* */ }
        }
        hit("try.total");
        if (this.id === TAP_ID) hit("try.tap");
    },
    onLeave(ret) {
        const r = ret.toInt32();
        const yve = YVE_IDS.indexOf(this.id) >= 0;
        if (yve) {
            hit("try.yve");
            hit("ret." + r);
            logcap("try", 200, "[try] id=" + this.id + " ret=" + r +
                " a4=" + this.a4 + " a5=" + this.a5 + " <- " + this.from);
        }
    },
});

// ---------------------------------------------------------------- UIKeySkill layer (input side)
hook("UIKeySkill.OnDragSkillFor122", RV.UIKey_OnDragSkillFor122, {
    onEnter() { hit("ui.drag122"); },
});
hook("UIKeySkill.OnDragSkillForceDir", RV.UIKey_OnDragSkillForceDir, {
    onEnter() { hit("ui.dragforce"); },
});
hook("UIKeySkill.TrackSkillCastResult", RV.UIKey_TrackSkillCastResult, {
    onEnter() { hit("ui.track"); },
});
hook("KeySkillContinuous.CanUseSkill", RV.KeySkillContinuous_CanUseSkill, {
    onEnter() { hit("ui.canuse"); },
});

// ---------------------------------------------------------------- accepted-cast side (reference)
hook("NewSendSkillBattleOperData", RV.NewSendSkillBattleOperData, {
    onEnter() { hit("net.newsend"); },
});
const lastAt = {};
hook("MakeSrcSpellOut", RV.MakeSrcSpellOut, {
    onEnter(args) { this.sc = args[1]; hit("exec.makesrc"); },
    onLeave() {
        const sc = this.sc;
        if (!sc || sc.isNull()) return;
        let id = 0;
        try { id = sc.add(0x14).readS32(); } catch (e) { return; }
        if (id !== TAP_ID) return;
        hit("exec.tap");
        const now = Date.now();
        const d = lastAt[TAP_ID] ? " d=+" + (now - lastAt[TAP_ID]) + "ms" : "";
        lastAt[TAP_ID] = now;
        logcap("cast", 200, "[cast] tap" + d);
    },
});

setInterval(() => {
    const keys = Object.keys(C).sort();
    log("[stats] " + keys.map((k) => k + "=" + C[k]).join(" "));
}, 4000);

log("[*] v7 armed.");
log("[*] IF try.yve grows at MASH rate while exec.tap grows at FLOOR rate -> read the [try] ret codes: that refusal is the gate to patch.");
log("[*] IF try.yve itself only grows at FLOOR rate -> input never reaches it; the lock is in the UIKeySkill/touch layer (look at ui.* counters).");
