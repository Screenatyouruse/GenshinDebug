// sample_clock.js — sample clock ticks across 2 seconds
const lib = Process.getModuleByName("liblogic.so");
const E = (n, r, a) => new NativeFunction(lib.getExportByName(n), r, a);
const domainGet = E("il2cpp_domain_get", "pointer", []);
const threadAttach = E("il2cpp_thread_attach", "pointer", ["pointer"]);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const fieldFromName = E("il2cpp_class_get_field_from_name", "pointer", ["pointer", "pointer"]);
const fieldStaticGetValue = E("il2cpp_field_static_get_value", "void", ["pointer", "pointer"]);

function findKlass(ns, name) {
    const domain = domainGet();
    const sb = Memory.alloc(8);
    const asms = domainGetAssemblies(domain, sb);
    const n = sb.readU64().toNumber();
    const mk = s => Memory.allocUtf8String(s);
    for (let i = 0; i < n; i++) {
        const img = assemblyGetImage(asms.add(i * Process.pointerSize).readPointer());
        if (img.isNull()) continue;
        const k = classFromName(img, mk(ns), mk(name));
        if (!k.isNull()) return k;
    }
    return null;
}

function getStaticInstance(klass, fieldName) {
    if (!klass || klass.isNull()) return ptr(0);
    const f = fieldFromName(klass, Memory.allocUtf8String(fieldName));
    if (f.isNull()) return ptr(0);
    const out = Memory.alloc(8);
    fieldStaticGetValue(f, out);
    return out.readPointer();
}

threadAttach(domainGet());
const kBM = findKlass("", "BattleManager");
const kLBM = findKlass("Battle", "LogicBattleManager") || findKlass("", "LogicBattleManager");

const bm = getStaticInstance(kBM, "Instance");
const lbm = getStaticInstance(kLBM, "Instance");

console.log("[*] Sampling clocks across 2 seconds...");

let count = 0;
const interval = setInterval(() => {
    let ft = 0, lcur = 0, showTime = 0, mainDead = 0, endType = 0;
    if (!lbm.isNull()) {
        ft = lbm.add(316).readU32();
        const fEnd = fieldFromName(kLBM, Memory.allocUtf8String("<m_EndType>k__BackingField"));
        if (!fEnd.isNull()) {
            const outE = Memory.alloc(4);
            fieldStaticGetValue(fEnd, outE);
            endType = outE.readS32();
        }
    }
    if (!bm.isNull()) {
        lcur = bm.add(40).readU64();
        showTime = bm.add(208).readS64();
        mainDead = bm.add(128).readU8();
    }
    console.log(`[tick ${count}] m_uiFrameTime: ${ft} | lCurFrame: ${lcur} | MainTowerDead: ${mainDead} | EndType: ${endType}`);
    count++;
    if (count >= 5) {
        clearInterval(interval);
        console.log("[*] Sampling complete.");
    }
}, 500);
