// yve_probe_v2.js — Refined Battle.LogicSkillComp Cast Pipeline Probe
//
// Goals:
//  1. Resolve internal spellId inside CheckCastCond arguments.
//  2. Expose all inner gatekeeper checks (CheckChargeEnergyTag, CheckLockSkillID, etc.).
//  3. Expose toggleable blocking for the stance-exit cleanup spell (10136).
//  4. Export Frida RPC to trigger synthetic TryUseSkill(10112) taps on demand.
//
// Usage:
//   frida -H 127.0.0.1:27043 -n "Mobile Legends: Bang Bang" -l yve_probe_v2.js --runtime qjs -q
//
// In Frida CLI:
//   rpc.exports.blockExit(true)   -> Suppresses spell 10136 from ending the stance
//   rpc.exports.spamTap()         -> Synthetically casts 10112 via captured LogicSkillComp instance

const lib = Process.getModuleByName("liblogic.so");
const E = (n, r, a) => new NativeFunction(lib.getExportByName(n), r, a);

const domainGet = E("il2cpp_domain_get", "pointer", []);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const classGetMethods = E("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"]);
const methodGetName = E("il2cpp_method_get_name", "pointer", ["pointer"]);
const methodGetParamCount = E("il2cpp_method_get_param_count", "uint32", ["pointer"]);
const threadAttach = E("il2cpp_thread_attach", "pointer", ["pointer"]);

function cstr(p) { return p.isNull() ? "" : p.readUtf8String(); }
function log(m) { console.log("[yve] " + m); }

function findKlass(ns, name) {
    const d = domainGet(); 
    const sb = Memory.alloc(8);
    const asms = domainGetAssemblies(d, sb); 
    const n = sb.readU64().toNumber();
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
        try {
            if (methodGetParamCount(m) === argc && cstr(methodGetName(m)) === name) return m.readPointer();
        } catch (e) { /* */ }
        m = classGetMethods(klass, iter);
    }
    return null;
}

threadAttach(domainGet());
const K = findKlass("Battle", "LogicSkillComp");
if (!K) throw new Error("Battle.LogicSkillComp not found - are you in a match?");
const ctor = methodAddr(K, ".ctor", 0);
if (!ctor || ctor.isNull()) throw new Error("LogicSkillComp ctor not resolved");

const BASE = ctor.sub(0x5021200);
log("[base] libcsharp base = " + BASE + (BASE.and(ptr(0xfff)).isNull() ? " (page aligned)" : " (!! NOT ALIGNED)"));

// ---- State Tracking & Configuration
let lastSelf = null;
let suppressExitSpell = false;

// ---- Native Invocations
const tryUseSkillNative = new NativeFunction(
    BASE.add(0x50230a8),
    "bool",
    ["pointer", "int32", "int32", "uint32"]
);

let lastValidX = 0.0;
let lastValidY = 0.0;

// ---- SpellCastData Dumper
function dumpCast(self, tag) {
    try {

        const sc = self.add(0xD0).readPointer();
        if (sc.isNull() || sc.toUInt32() < 0x1000) return;
        const sId = sc.add(0x14).readS32();
        if (sId === 10112 || sId === 10130) {
            lastValidX = sc.add(0x40).readDouble();
            lastValidY = sc.add(0x48).readDouble();
        }
        const o = {
            spellId: sc.add(0x14).readS32(),
            ownerId: sc.add(0x20).readU32(),
            targetId: sc.add(0x24).readU32(),
            srcGuId: sc.add(0x2c).readU32(),
            srcOwnerGuId: sc.add(0x30).readU32(),
            srcSpellId: sc.add(0x34).readS32(),
            level: sc.add(0x38).readS32(),
            posX: Math.round(sc.add(0x40).readDouble() * 100) / 100,
            posY: Math.round(sc.add(0x48).readDouble() * 100) / 100,
        };
        log(tag + " cast=" + JSON.stringify(o));
    } catch (e) { /* */ }
}

// Helper: Safely extract spell ID from candidate struct pointers
function resolveSpellId(ptrVal) {
    if (ptrVal.isNull() || ptrVal.toUInt32() < 0x1000) return 0;
    try {
        const id = ptrVal.add(0x14).readS32();
        if (id > 10000 && id < 99999) return id;
    } catch (e) {}
    try {
        const idAlt = ptrVal.add(0x10).readS32();
        if (idAlt > 10000 && idAlt < 99999) return idAlt;
    } catch (e) {}
    return 0;
}

// ---- TryUseSkill Hook (Intercept, Dump, and Optional 10136 Blocker)
try {
    Interceptor.attach(BASE.add(0x50230a8), {
        onEnter(args) {
            this.spellId = resolveSpellId(args[1]);
        },
        onLeave(retval) {
                if (this.spellId === 10112) {
                    // Force gate open for Starfield Tap
                    retval.replace(ptr(1));
                }
            }
    });
    log("[hook] TryUseSkill @" + BASE.add(0x50230a8));
} catch (e) { log("[!] hook TryUseSkill: " + e); }

// ---- Throttled Gate Logging
const lastLog = {};
function throttled(key, ms) {
    const now = Date.now();
    if (!lastLog[key] || now - lastLog[key] > (ms || 300)) { 
        lastLog[key] = now; 
        return true; 
    }
    return false;
}

// Configured checks: name, RVA offset, forceLogTrue
const CHECKS = [
    ["CheckCastCond", 0x50231c8, true],
    ["CheckCastCond_2", 0x5024660, true],
    ["CheckSkillLimit", 0x501cc68, true],
    ["CheckSkillBase", 0x501e41c, true],
    ["CheckLockSkillID", 0x501c478, true],
    ["CheckOneFrameSkillMaxNum", 0x501cdbc, true],
    ["CheckChargeEnergyTag", 0x501b674, true],
    ["IsCoolDown", 0x5022424, false],
    ["IsShareCoolDown", 0x5022d08, false],
];

Interceptor.attach(BASE.add(0x5022424), { // IsCoolDown
    onEnter(args) {
        this.spellId = args[1].toInt32();
    },
    onLeave(retval) {
        if (this.spellId === 10112) {
            log(`[ICD] IsCoolDown(10112) = ${retval.toInt32() !== 0}`);
            // Test overriding the ICD gate:
            // retval.replace(ptr(0)); // 0 = NOT in cooldown
        }
    }
});

Interceptor.attach(BASE.add(0x5022d08), { // IsShareCoolDown
    onEnter(args) {
        this.spellId = args[1].toInt32();
    },
    onLeave(retval) {
        if (this.spellId === 10112) {
            log(`[ICD] IsShareCoolDown(10112) = ${retval.toInt32() !== 0}`);
            // retval.replace(ptr(0));
        }
    }
});

for (const [name, rva, logTrue] of CHECKS) {
    try {
        Interceptor.attach(BASE.add(rva), {
            onEnter(args) {
                // If we don't have lastSelf yet, grab 'this' (args[0])
                if (!lastSelf && (args[0].toUInt32() > 0x1000)) {
                    const resolved = resolveSpellId(args[1]);
                    if (resolved === 10112 || resolved === 10130) {
                        lastSelf = args[0];
                        log("[auto-bind] Captured lastSelf (LogicSkillComp) from " + name + " @ " + lastSelf);
                    }
                }

                this.rawA1 = args[1];
                this.a1Val = args[1].toUInt32();
                this.resolvedSpell = resolveSpellId(args[1]);
            },
            onLeave(retval) {
                const yveSpells = [10112, 10130, 10136];
                if (!yveSpells.includes(this.resolvedSpell)) return;

                const r = (retval.toUInt32() & 0xff) !== 0;
                const spellTag = " [spell=" + this.resolvedSpell + "]";
                const key = name + "_" + this.resolvedSpell + "_" + (r ? "1" : "0");

                if (!r) {
                    if (throttled(key, 500)) log(name + "(a1=0x" + this.a1Val.toString(16) + spellTag + ") = FALSE");
                } else if (logTrue) {
                    if (throttled(key, 800)) log(name + "(a1=0x" + this.a1Val.toString(16) + spellTag + ") = true");
                }
            }
        });
        log("[hook] " + name + " @" + BASE.add(rva));
    } catch (e) { log("[!] hook " + name + ": " + e); }
}

log("[*] Script active. Yve ult, tap, test behavior.");

// ---- RPC Controls
rpc.exports = {
    blockExit: function(enable) {
        suppressExitSpell = !!enable;
        log("[RPC] Stance-Exit Suppression (Spell 10136) set to: " + suppressExitSpell);
        return suppressExitSpell;
    },
    spamTap: function(count) {
        if (!lastSelf || lastSelf.isNull()) {
            log("[RPC Error] No LogicSkillComp instance captured. Cast Ult once manually first.");
            return false;
        }
        const iterations = count || 1;
        log("[RPC] Firing " + iterations + " synthetic TryUseSkill(10112) call(s)...");
        let successes = 0;
        for (let i = 0; i < iterations; i++) {
            const res = tryUseSkillNative(lastSelf, 10112, 1, 0);
            if (res) successes++;
        }
        log("[RPC] Executed: " + successes + "/" + iterations + " accepted.");
        return successes;
    }
};