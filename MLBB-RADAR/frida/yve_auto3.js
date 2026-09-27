// yve_auto3.js — auto Yve ult strike via the REAL input entry: ShowUnitAIComp.ReceiveUseSkill.
//
// Why this is the one (v1/v2 findings):
//   - v2: ILOGIC_TryUseSkill alone validates but does NOT send; replaying it gave ret=0
//     and (almost) no casts -> the send happens later, in the AI comp's per-frame update.
//   - ShowSelfPlayer.ReceiveUseSkill(self, skillId) is the entry the manual input feeds;
//     it calls ShowUnitAIComp.ReceiveUseSkill(*(self+0xBB0), skillId), which just STAGES
//     the request: bAutoAttk=1, iAutoAttackSkillId=<skill>. The comp's Update then runs
//     the validated cast path at the sim's own cadence.
//   - The ult ammo/charge bookkeeping lives ABOVE this call (in the UI/input wrapper),
//     so calling ReceiveUseSkill directly = automatic skill casting with normal FX/damage
//     and no charge loss. That is the "working POC" behaviour: vanilla-speed strikes,
//     ammo untouched.
//
// run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l yve_auto3.js --runtime qjs -q
// practice -> Yve -> ult once (arms) -> strike 1 auto-fires until the window closes.
//
// read: [stage] our staging call, [op] SENT, [echo], [cast] executed (+ cadence).
//       ammo counter in-game should stay put. If strikes stop, ult again.

const CFG = {
    RATE_MS: 500,        // set the auto-attack flag this often; sim picks its own cadence
    ULT_MS: 12000,       // auto window after the ult cast
    TAP_ID: 10112,
    ULT_ID: 10130,
    YVE_IDS: [10110, 10112, 10120, 10130, 10135, 10136, 10161, 10173, 10180],
    ATTRIB_MS: 40,
    LOG_STAGE: true,     // log every staging call
};

const RV = {
    ctor: 0x5021200, GetOwner: 0x50211f8,
    MakeSrcSpellOut: 0x5024af4,
    MakeNormalSpell: 0x502a324,              // per-frame sim tick (game thread)
    ILOGIC_TryUseSkill: 0x3588f90,
    NewSendSkillBattleOperData: 0x2e38f14,
    Oper_On_CastSkill: 0x2e212c4,
    ShowUnitAIComp_ReceiveUseSkill: 0x454d4bc,
    ShowSelfPlayer_ReceiveUseSkill: 0x39b9074,
    ShowSelfPlayer_compOffset: 0xBB0,        // *(self+0xBB0) = the unit's ShowUnitAIComp
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
function log(m) { console.log("[auto3] " + m); }
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

// void ReceiveUseSkill(this, uint skillId)
const receiveUseSkill = new NativeFunction(BASE.add(RV.ShowUnitAIComp_ReceiveUseSkill), "void",
    ["pointer", "uint32"]);

const S = {
    comp: null, armedUntil: 0,
    staged: 0, ops: 0, echoes: 0, casts: 0,
    tickSeen: 0, lastStageAt: 0, lastCastAt: 0, minDelta: 0, inFire: false,
};

// ---------------------------------------------------------------- capture the player's comp
Interceptor.attach(BASE.add(RV.ShowUnitAIComp_ReceiveUseSkill), {
    onEnter(args) {
        if (S.inFire) return;                       // our own call
        const id = args[1].toInt32();
        if (CFG.YVE_IDS.indexOf(id) < 0) return;
        if (!S.comp) {
            S.comp = args[0];
            log("[capture] player ShowUnitAIComp = " + S.comp + " (from manual id=" + id + ")");
        }
        if (id === CFG.ULT_ID) {
            S.armedUntil = Date.now() + CFG.ULT_MS;
            log("[arm] ult staged (" + CFG.ULT_MS + "ms window)");
        }
    },
});
// fallback capture path: the self-level entry, in case the comp-level one is inlined later
Interceptor.attach(BASE.add(RV.ShowSelfPlayer_ReceiveUseSkill), {
    onEnter(args) {
        if (S.inFire) return;
        if (!S.comp) {
            try {
                const c = args[0].add(RV.ShowSelfPlayer_compOffset).readPointer();
                if (!c.isNull()) { S.comp = c; log("[capture] comp via ShowSelfPlayer = " + c); }
            } catch (e) { /* */ }
        }
    },
});
// arm on the ult executing, independent of who staged it
Interceptor.attach(BASE.add(RV.MakeSrcSpellOut), {
    onEnter(args) { this.sc = args[1]; },
    onLeave() {
        const sc = this.sc;
        if (!sc || sc.isNull()) return;
        let id = 0; try { id = sc.add(0x14).readS32(); } catch (e) { return; }
        if (id === CFG.ULT_ID && !S.armedUntil) {
            S.armedUntil = Date.now() + CFG.ULT_MS;
            log("[arm] ult executed");
        }
        if (id !== CFG.TAP_ID) return;
        const now = Date.now();
        S.casts++;
        if (S.lastCastAt) {
            const d = now - S.lastCastAt;
            if (!S.minDelta || d < S.minDelta) S.minDelta = d;
            log("[cast] strike executed d=+" + d + "ms (min " + S.minDelta + "ms)");
        } else {
            log("[cast] strike executed (first)");
        }
        S.lastCastAt = now;
    },
});

// ---------------------------------------------------------------- chain verification
let otherOps = 0;
Interceptor.attach(BASE.add(RV.NewSendSkillBattleOperData), {
    onEnter() {
        if ((Date.now() - S.lastStageAt) < CFG.ATTRIB_MS) { S.ops++; log("[op] SENT after our stage"); }
        else otherOps++;
    },
});
Interceptor.attach(BASE.add(RV.Oper_On_CastSkill), {
    onEnter() {
        if ((Date.now() - S.lastStageAt) < CFG.ATTRIB_MS + 300) { S.echoes++; }
    },
});

function stage() {
    if (!S.comp) return;
    S.inFire = true;
    try {
        S.lastStageAt = Date.now();
        receiveUseSkill(S.comp, CFG.TAP_ID);
        S.staged++;
        if (CFG.LOG_STAGE) {
            const a = S.armedUntil > Date.now() ? "armed" : "idle";
            log("[stage] #" + S.staged + " ReceiveUseSkill(" + CFG.TAP_ID + ")  [" + a + "]");
        }
    } catch (e) {
        log("[!] stage threw: " + e);
    } finally {
        S.inFire = false;
    }
}

// ---------------------------------------------------------------- game-thread tick
Interceptor.attach(BASE.add(RV.MakeNormalSpell), {
    onEnter() {
        S.tickSeen++;
        if (S.tickSeen === 1) log("[tick] MakeNormalSpell ticking (game thread)");
        if (!S.comp) return;
        if (Date.now() > S.armedUntil) return;
        if (Date.now() - S.lastStageAt < CFG.RATE_MS) return;
        stage();
    },
});

setInterval(() => {
    log("[stats] ticks=" + S.tickSeen + " staged=" + S.staged + " ops=" + S.ops +
        " echoes=" + S.echoes + " casts=" + S.casts + " minDelta=" + S.minDelta + "ms" +
        " otherOps=" + otherOps);
}, 5000);

log("[*] armed. ult once with Yve -> ReceiveUseSkill auto-stages the strike (rate " + CFG.RATE_MS + "ms).");
log("[*] expect: [stage] -> [op] SENT -> [cast]; ammo counter unchanged.");
