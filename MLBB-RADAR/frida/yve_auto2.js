// yve_auto2.js — auto Yve ult strike, v2: fire on the GAME THREAD + verify the op.
//
// v1 (yve_auto.js) result: ILOGIC_TryUseSkill(battleData=0x1, operator, 10112, 1, 0)
// returned 0 every time when called from the frida timer thread, but NOTHING happened
// on screen and no damage. The game's own calls (manual tap / ult) return 0 AND cast.
// Conclusion: the call itself is right, the CONTEXT is wrong -> the sim ignores skills
// issued from a non-game thread (frame/command-list guard).
//
// v2 changes:
//   1. fires from inside Battle.LogicSkillComp.MakeNormalSpell (0x502a324, per-frame sim
//      tick on the game thread) instead of setInterval.
//   2. verifies the full chain: NewSendSkillBattleOperData (op built+sent) ->
//      Oper_On_CastSkill (echo) -> MakeSrcSpellOut (executed). Each fire is attributed
//      by timestamp, so we see exactly where it dies if it still dies.
//
// run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l yve_auto2.js --runtime qjs -q
// practice -> Yve -> ult once. Read:
//   [fire]   our call + ret
//   [op]     SENT   (NewSendSkillBattleOperData followed our fire within 40ms)
//   [echo]   received by Oper_On_CastSkill
//   [cast]   tap executed (cadence measured)
// If you get [fire] but no [op], the send lives in the caller (ShowUnitAIComp.TryUseSkill)
// and we replay that one instead.

const CFG = {
    RATE_MS: 480,       // fire interval; 480 ~ vanilla floor, 300/200 to probe
    ULT_MS: 10000,
    TAP_ID: 10112,
    ULT_ID: 10130,
    YVE_IDS: [10110, 10112, 10120, 10130, 10135, 10136, 10161, 10173, 10180],
    REFUSAL_LIMIT: 8,
    ATTRIB_MS: 40,      // a net/echo event within this window is attributed to our fire
};

const RV = {
    ctor: 0x5021200, GetOwner: 0x50211f8,
    MakeSrcSpellOut: 0x5024af4,
    MakeNormalSpell: 0x502a324,          // per-frame sim tick (game thread)
    ILOGIC_TryUseSkill: 0x3588f90,
    NewSendSkillBattleOperData: 0x2e38f14,
    Oper_On_CastSkill: 0x2e212c4,
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
function log(m) { console.log("[auto2] " + m); }
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

const ilogicTry = new NativeFunction(BASE.add(RV.ILOGIC_TryUseSkill), "int",
    ["pointer", "pointer", "int", "int", "int"]);

const S = {
    battle: null, operator: null, a4: 1, a5: 0,
    armedUntil: 0, calls: 0, accepted: 0, refused: 0, streak: 0,
    lastFireAt: 0, lastTapAt: 0, minDelta: 0, tickSeen: 0,
};

// ---------------------------------------------------------------- chain verification
let otherOps = 0, otherEchoes = 0;
Interceptor.attach(BASE.add(RV.NewSendSkillBattleOperData), {
    onEnter() {
        if ((Date.now() - S.lastFireAt) < CFG.ATTRIB_MS) log("[op] SENT <- our fire");
        else otherOps++;
    },
});
Interceptor.attach(BASE.add(RV.Oper_On_CastSkill), {
    onEnter() {
        if ((Date.now() - S.lastFireAt) < CFG.ATTRIB_MS) log("[echo] received <- our fire");
        else otherEchoes++;
    },
});
Interceptor.attach(BASE.add(RV.MakeSrcSpellOut), {
    onEnter(args) { this.sc = args[1]; },
    onLeave() {
        const sc = this.sc;
        if (!sc || sc.isNull()) return;
        let id = 0;
        try { id = sc.add(0x14).readS32(); } catch (e) { return; }
        if (id !== CFG.TAP_ID) return;
        const now = Date.now();
        const own = (now - S.lastFireAt) < (CFG.ATTRIB_MS + 300);
        let d = "";
        if (S.lastTapAt) {
            d = " d=+" + (now - S.lastTapAt) + "ms";
            const delta = now - S.lastTapAt;
            if (!S.minDelta || delta < S.minDelta) S.minDelta = delta;
        }
        S.lastTapAt = now;
        log("[cast] tap executed" + d + " (min " + S.minDelta + "ms)" + (own ? "  <- our fire" : ""));
    },
});

// ---------------------------------------------------------------- capture (game's own calls)
Interceptor.attach(BASE.add(RV.ILOGIC_TryUseSkill), {
    onEnter(args) {
        const id = args[2].toInt32();
        if (CFG.YVE_IDS.indexOf(id) < 0) return;
        if (!S.battle) {
            S.battle = args[0]; S.operator = args[1];
            log("[capture] battleData=" + S.battle + " operator=" + S.operator + " (from id=" + id + ")");
        }
        S.a4 = args[3].toInt32();
        S.a5 = args[4].toInt32();
        if (id === CFG.ULT_ID) {
            S.armedUntil = Date.now() + CFG.ULT_MS;
            S.streak = 0;
            log("[arm] ult seen (" + CFG.ULT_MS + "ms window)");
        }
    },
});

function fire() {
    let r = -999;
    try {
        S.lastFireAt = Date.now();
        r = ilogicTry(S.battle, S.operator, CFG.TAP_ID, S.a4, S.a5);
    } catch (e) { log("[!] call threw: " + e); return; }
    S.calls++;
    if (r === 0) { S.accepted++; S.streak = 0; } else { S.refused++; S.streak++; }
    log("[fire] #" + S.calls + " ret=" + r + " (ok=" + S.accepted + " refused=" + S.refused + ")");
    if (S.streak >= CFG.REFUSAL_LIMIT) {
        log("[disarm] " + S.streak + " consecutive refusals");
        S.armedUntil = 0;
    }
}

// ---------------------------------------------------------------- game-thread tick
Interceptor.attach(BASE.add(RV.MakeNormalSpell), {
    onEnter() {
        S.tickSeen++;
        if (S.tickSeen === 1) log("[tick] MakeNormalSpell is ticking (game thread)");
        if (!S.battle || !S.operator) return;
        if (Date.now() > S.armedUntil) return;
        if (Date.now() - S.lastFireAt < CFG.RATE_MS) return;
        fire();
    },
});

setInterval(() => {
    log("[stats] ticks=" + S.tickSeen + " fires=" + S.calls + " ok=" + S.accepted +
        " refused=" + S.refused + " otherOps=" + otherOps + " otherEcho=" + otherEchoes +
        " minDelta=" + S.minDelta + "ms");
}, 5000);

log("[*] armed. ult once -> strike auto-fires from the game thread (rate " + CFG.RATE_MS + "ms).");
log("[*] watch [op] SENT / [echo] / [cast]: whichever line is missing tells us where it dies.");
