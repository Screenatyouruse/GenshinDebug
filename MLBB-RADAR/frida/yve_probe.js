// yve_probe.js v4 — Yve tap ICD probe, delta edition.
//
// v3 findings: tap = spell 10112 (owner 16); ult = 10130; AddLockSkillID(10110/10120/10130)
// fires once at ult start (locks her 3 slots); no CheckLockSkillID BLOCKED, no IsCoolDown(101xx).
// v4 adds: per-skill DELTAS (ms between casts of the same spell id) so we can see the ICD floor,
// and hooks the two lock lists we were missing (trigger ids / effect ids).
//
// run:
//   frida -H 127.0.0.1:27043 -n "Mobile Legends: Bang Bang" -l yve_probe.js --runtime qjs -q
// practice -> Yve -> ult -> MASH the tap as fast as you can for ~10s.
// Then a second pass tapping at a normal, deliberate pace. Paste from [*] armed.
//
// What to read: "[cast] 10112 ... d=+NNNms" — if d bottoms out at a stable floor while you mash,
// that floor IS the ICD. If d follows your tapping, there is no ICD in the cast path.

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
const BASE = ctor.sub(0x5021200);
log("[base] " + BASE + (BASE.and(ptr(0xfff)).isNull() ? " (aligned)" : " (!! NOT ALIGNED)"));

function castLine(self) {
    try {
        const sc = self.add(0xD0).readPointer();
        if (sc.isNull() || sc.toUInt32() < 0x1000) return null;
        
        const spellId = sc.add(0x14).readS32();
        if (!spellId) return null;
        return "spell=" + spellId + " owner=" + sc.add(0x20).readU32() +
            " srcGuId=" + sc.add(0x2c).readU32() + " srcSpell=" + sc.add(0x34).readS32() +
            " pos=(" + (Math.round(sc.add(0x40).readDouble() * 10) / 10) + "," +
            (Math.round(sc.add(0x48).readDouble() * 10) / 10) + ")";
    } catch (e) { return null; }
}

const counts = {};
function allow(key, limit) {
    counts[key] = (counts[key] || 0) + 1;
    if (counts[key] <= limit) return true;
    if (counts[key] === limit + 1) log("[cap] " + key + " suppressed");
}

// ---- cast makers with per-spell delta (the ICD measurement)
const lastAt = {};
for (const [name, rva, cap] of [["MakeSrcSpellOut", 0x5024af4, 300], ["MakeSonSpell", 0x5029d38, 10],
                                ["MakeNormalSpell", 0x502a324, 120], ["MakeNomalSpell", 0x502a980, 60]]) {
    try {
        let self = null;
        Interceptor.attach(BASE.add(rva), {
            onEnter(args) { self = args[0]; },
            onLeave() {
                if (!self) return;
                const line = castLine(self);
                if (!line || !allow(name, cap)) return;
                let d = "";
                try {
                    const sc = self.add(0xD0).readPointer();
                    const id = sc.add(0x14).readS32();
                    const now = Date.now();
                    if (lastAt[id]) d = " d=+" + (now - lastAt[id]) + "ms";
                    lastAt[id] = now;
                } catch (e) { /* */ }
                log(name + " " + line + d);
            },
        });
        log("[hook] " + name + " @" + BASE.add(rva));
    } catch (e) { log("[!] hook " + name + ": " + e); }
}

// ---- all three lock lists: log adds, and log blocked checks
function hookAdd(tag, rva, cap) {
    try {
        Interceptor.attach(BASE.add(rva), {
            onEnter(args) {
                const id = args[1].toUInt32();
                if (id && allow(tag, cap)) log(tag + "(id=" + id + " / 0x" + id.toString(16) + ")");
            },
        });
        log("[hook] " + tag + " @" + BASE.add(rva));
    } catch (e) { log("[!] hook " + tag + ": " + e); }
}
function hookCheck(tag, rva) {
    try {
        let id = 0;
        Interceptor.attach(BASE.add(rva), {
            onEnter(args) { id = args[1].toUInt32(); },
            onLeave(retval) {
                if ((retval.toUInt32() & 1) === 0 && allow(tag + ":blocked", 120))
                    log(tag + "(id=" + id + " / 0x" + id.toString(16) + ") = BLOCKED");
            },
        });
        log("[hook] " + tag + " @" + BASE.add(rva));
    } catch (e) { log("[!] hook " + tag + ": " + e); }
}
hookAdd("AddLockSkillID", 0x502b284, 200);
hookAdd("AddLockSkillTriggerID", 0x502b448, 200);
hookAdd("AddLockSkillEffectID", 0x502b618, 200);
hookCheck("CheckLockSkillID", 0x501c478);
hookCheck("CheckLockSkillTriggerID", 0x502b3ac);
hookCheck("CheckLockSkillEffectID", 0x502b57c);

// ---- IsCoolDown for hero skills (101xx)
try {
    let cid = 0;
    Interceptor.attach(BASE.add(0x5022424), {
        onEnter(args) { cid = args[1].toUInt32(); },
        onLeave(retval) {
            if (cid < 10100 || cid > 10199) return;
            if (allow("IsCoolDown", 100)) log("IsCoolDown(id=" + cid + ") ret=" + (retval.toUInt32() & 1));
        },
    });
    log("[hook] IsCoolDown @" + BASE.add(0x5022424));
} catch (e) { log("[!] hook IsCoolDown: " + e); }

log("[*] armed - ult, then MASH the tap ~10s, then tap deliberately ~10s");
