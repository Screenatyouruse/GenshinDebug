// live_bm_test.js — inspect live BattleManager & LogicBattleManager instance fields
// Run: frida -H 127.0.0.1:27043 -n "Mobile Legends: Bang Bang" -l live_bm_test.js --runtime qjs -q

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

console.log(`[+] kBM: ${kBM}, kLBM: ${kLBM}`);

const bm = getStaticInstance(kBM, "Instance");
console.log(`[+] BattleManager.Instance: ${bm}`);

if (!bm.isNull() && bm.toUInt32() >= 0x1000) {
    const self = bm.add(72).readPointer();
    const mainTowerDead = bm.add(128).readU8();
    const lCurFrame = bm.add(40).readU64();
    const lastShowFrameTime = bm.add(208).readS64();
    const lastFrameTime = bm.add(264).readU64();

    console.log(`    m_LocalPlayerShow (+72): ${self}`);
    console.log(`    m_MainTowerDead (+128): ${mainTowerDead}`);
    console.log(`    m_lCurFrame (+40): ${lCurFrame}`);
    console.log(`    _lastShowFrameTime (+208): ${lastShowFrameTime}`);
    console.log(`    m_lastFrameTime (+264): ${lastFrameTime}`);
} else {
    console.log("    BattleManager.Instance is null or invalid");
}

const lbm = getStaticInstance(kLBM, "Instance");
console.log(`[+] LogicBattleManager.Instance: ${lbm}`);

if (!lbm.isNull() && lbm.toUInt32() >= 0x1000) {
    const frameTime = lbm.add(316).readU32();
    const recvFrameTime = lbm.add(308).readU32();
    const failCampType = lbm.add(44).readS32();
    const campAMainTower = lbm.add(112).readPointer();
    const campBMainTower = lbm.add(120).readPointer();

    console.log(`    m_uiFrameTime (+316): ${frameTime}`);
    console.log(`    m_uiRecvNetFrameTime (+308): ${recvFrameTime}`);
    console.log(`    m_failCampType (+44): ${failCampType}`);
    console.log(`    m_CampAMainTower (+112): ${campAMainTower}`);
    console.log(`    m_CampBMainTower (+120): ${campBMainTower}`);

    // Read endType static field
    const fEndType = fieldFromName(kLBM, Memory.allocUtf8String("<m_EndType>k__BackingField"));
    if (!fEndType.isNull()) {
        const outEnd = Memory.alloc(4);
        fieldStaticGetValue(fEndType, outEnd);
        console.log(`    <m_EndType>k__BackingField (static): ${outEnd.readS32()}`);
    }
} else {
    console.log("    LogicBattleManager.Instance is null or invalid");
}
