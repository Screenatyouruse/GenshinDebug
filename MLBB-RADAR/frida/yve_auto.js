// yve_auto.js — auto-cast Yve's ult strike (10112) through the game's own cast entry.
//
// Chain (v6/v7 verified, live):
//   tap input -> Battle.ShowUnitAIComp.TryUseSkill -> LogicBattleData.ILOGIC_TryUseSkill(
//                    battleData, operator, skillId=10112, a4=1, a5=0)   <- all ints/pointers
//             -> op built + sent (NewSendSkillBattleOperData) -> prm skill_after_sending
//             -> recv echo (Oper_On_CastSkill) -> MakeSrcSpellOut -> [cast]
//   Every accepted call returned 0 and produced a normal cast. No refusals observed anywhere.
//
// This script captures (battleData, operator) from the first Yve cast it sees, then re-issues
// ILOGIC_TryUseSkill(10112) on a timer while the ult window is open. It is the exact call the
// game's own input path makes, so validation/FX/animation are the normal ones; the manual
// input wrapper (where the ~500ms tap throttle and the ult ammo bookkeeping live) is skipped.
//
// run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l yve_auto.js --runtime qjs -q
// practice -> Yve -> ult once. Auto-fires until ULT_MS after the ult; ult again to re-arm.
//
// Tuning: RATE_MS 420 = vanilla-ish floor. Drop to 250/200 and read the ret codes:
//   ret 0  = accepted (cast goes through)
//   ret != 0 = the sim refused -> that is the real cadence floor, read it off the accepted deltas.

const CFG = {
    RATE_MS: 700,       // fire interval
    ULT_MS: 10000,      // auto window after the ult cast
    TAP_ID: 10112,
    ULT_ID: 10130,
    YVE_IDS: [10110, 10112, 10120, 10130, 10135, 10136, 10161, 10173, 10180],
    MAX_CALLS: 0,       // 0 = unlimited inside the window
    REFUSAL_LIMIT: 6,   // consecutive non-zero returns -> disarm
    FREE_STATE: false,  // if true, also pocA-reset the caster comp after each accepted cast
    RESET_DELAY_MS: 250,
};

const RV = {
    ctor: 0x5021200, GetOwner: 0x50211f8,
    MakeSrcSpellOut: 0x5024af4,
    ILOGIC_TryUseSkill: 0x3588f90,
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
function log(m) { console.log("[auto] " + m); }
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

// the replay entry: int ILOGIC_TryUseSkill(ptr battleData, ptr operator, int skillId, int a4, int a5)
const ilogicTry = new NativeFunction(BASE.add(RV.ILOGIC_TryUseSkill), "int",
    ["pointer", "pointer", "int", "int", "int"]);

const state = {
    battle: null, operator: null, a4: 1, a5: 0,
    armedUntil: 0, calls: 0, accepted: 0, refused: 0, streak: 0,
    comp: null, lastTapAt: 0, minDelta: 0,
};

function capture(args, id) {
    if (CFG.YVE_IDS.indexOf(id) < 0) return;
    if (!state.battle) {
        state.battle = args[0];
        state.operator = args[1];
        log("[capture] battleData=" + state.battle + " operator=" + state.operator + " (from id=" + id + ")");
    }
    state.a4 = args[3].toInt32();
    state.a5 = args[4].toInt32();
}

// --- learn from the game's own cast attempts (manual taps + the ult)
Interceptor.attach(BASE.add(RV.ILOGIC_TryUseSkill), {
    onEnter(args) {
        const id = args[2].toInt32();
        capture(args, id);
        if (id === CFG.ULT_ID) {
            state.armedUntil = Date.now() + CFG.ULT_MS;
            state.streak = 0;
            log("[arm] ult seen (" + CFG.ULT_MS + "ms window)  battle=" + state.battle + " op=" + state.operator);
        }
    },
});

// --- accepted casts: measure the real cadence + keep the caster comp for optional reset
Interceptor.attach(BASE.add(RV.MakeSrcSpellOut), {
    onEnter(args) { this.comp = args[0]; this.sc = args[1]; },
    onLeave() {
        const sc = this.sc;
        if (!sc || sc.isNull()) return;
        let id = 0;
        try { id = sc.add(0x14).readS32(); } catch (e) { return; }
        if (id !== CFG.TAP_ID) return;
        state.comp = this.comp;
        const now = Date.now();
        if (state.lastTapAt) {
            const d = now - state.lastTapAt;
            if (!state.minDelta || d < state.minDelta) state.minDelta = d;
            if (state.accepted % 5 === 1) log("[cadence] accepted tap d=+" + d + "ms (min " + state.minDelta + "ms)");
        }
        state.lastTapAt = now;
    },
});

function freeState() {
    try {
        const comp = state.comp;
        if (!comp || comp.isNull()) return;
        const cur = comp.add(0x58).readPointer();
        if (!cur.isNull()) {
            comp.add(0x58).writePointer(ptr(0));
            log("[pocA] comp+0x58 cleared");
        }
        comp.add(0x80).writeU8(0);
    } catch (e) { /* */ }
}

// --- the auto fire loop
setInterval(() => {
    if (!state.battle || !state.operator) return;
    if (Date.now() > state.armedUntil) return;
    if (CFG.MAX_CALLS && state.calls >= CFG.MAX_CALLS) return;

    let r = -999;
    try {
        r = ilogicTry(state.battle, state.operator, CFG.TAP_ID, state.a4, state.a5);
    } catch (e) {
        log("[!] call threw: " + e);
        return;
    }
    state.calls++;
    if (r === 0) {
        state.accepted++; state.streak = 0;
        if (CFG.FREE_STATE) setTimeout(freeState, CFG.RESET_DELAY_MS);
    } else {
        state.refused++; state.streak++;
    }
    log("[fire] #" + state.calls + " ret=" + r +
        " (ok=" + state.accepted + " refused=" + state.refused + ")");
    if (state.streak >= CFG.REFUSAL_LIMIT) {
        log("[disarm] " + state.streak + " consecutive refusals - stopping (retry: ult again)");
        state.armedUntil = 0;
    }
}, CFG.RATE_MS);

log("[*] armed - ult once with Yve and the strike auto-fires (rate " + CFG.RATE_MS + "ms, window " + CFG.ULT_MS + "ms).");
log("[*] ret 0 = cast accepted. If refusals pile up, raise RATE_MS toward 480-520.");
if (CFG.FREE_STATE) log("[*] FREE_STATE on: cast state cleared " + CFG.RESET_DELAY_MS + "ms after each accepted cast.");
