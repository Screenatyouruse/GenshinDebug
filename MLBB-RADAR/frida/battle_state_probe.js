// battle_state_probe.js — live inspection of BattleManager & LogicBattleManager state
// Run: frida -H 127.0.0.1:27043 -n "Mobile Legends: Bang Bang" -l battle_state_probe.js --runtime qjs -q

const lib = Process.getModuleByName("liblogic.so");
const E = (n, r, a) => new NativeFunction(lib.getExportByName(n), r, a);

const domainGet = E("il2cpp_domain_get", "pointer", []);
const threadAttach = E("il2cpp_thread_attach", "pointer", ["pointer"]);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const classGetFields = E("il2cpp_class_get_fields", "pointer", ["pointer", "pointer"]);
const fieldGetName = E("il2cpp_field_get_name", "pointer", ["pointer"]);
const fieldGetOffset = E("il2cpp_field_get_offset", "uint32", ["pointer"]);
const fieldGetType = E("il2cpp_field_get_type", "pointer", ["pointer"]);
const typeGetName = E("il2cpp_type_get_name", "pointer", ["pointer"]);
const fieldGetFlags = E("il2cpp_field_get_flags", "int", ["pointer"]);

function cstr(p) { return p.isNull() ? "" : p.readUtf8String(); }

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

function dumpClassFields(klass, className) {
    if (!klass || klass.isNull()) {
        console.log(`[-] Class ${className} not found`);
        return [];
    }
    console.log(`\n=== FIELDS for ${className} (klass: ${klass}) ===`);
    const iter = Memory.alloc(8);
    iter.writePointer(ptr(0));
    let f = classGetFields(klass, iter);
    const fields = [];
    while (!f.isNull()) {
        try {
            const fname = cstr(fieldGetName(f));
            const off = fieldGetOffset(f);
            const t = fieldGetType(f);
            const tname = cstr(typeGetName(t));
            const flags = fieldGetFlags(f);
            const isStatic = (flags & 0x0010) !== 0;
            console.log(`  ${isStatic ? "[STATIC] " : ""}${fname} (${tname}) @ offset 0x${off.toString(16)} (${off})`);
            fields.push({ name: fname, offset: off, type: tname, isStatic });
        } catch (e) {
            console.log(`  [err reading field]: ${e}`);
        }
        f = classGetFields(klass, iter);
    }
    return fields;
}

threadAttach(domainGet());

console.log("[*] Attached to IL2CPP runtime");

const kBM = findKlass("", "BattleManager");
const kLBM = findKlass("Battle", "LogicBattleManager") || findKlass("", "LogicBattleManager");
const kBD = findKlass("", "BattleData");

dumpClassFields(kBM, "BattleManager");
dumpClassFields(kLBM, "LogicBattleManager");

// Read current live static instances from port.json addresses
// BattleManager.Instance @ 0x6f5530cc40
// LogicBattleManager.Instance @ 0x6f5532cc90
try {
    const bmPtr = ptr("0x6f5530cc40").readPointer();
    console.log(`\n[*] Live BattleManager.Instance: ${bmPtr}`);
    if (!bmPtr.isNull()) {
        const selfPtr = bmPtr.add(72).readPointer();
        console.log(`    m_LocalPlayerShow @ +72: ${selfPtr}`);
    }
} catch (e) {
    console.log(`[-] Err reading BattleManager.Instance: ${e}`);
}

try {
    const lbmStatic = ptr("0x6f5532cc90");
    const lbmPtr = lbmStatic.add(16).readPointer();
    console.log(`[*] Live LogicBattleManager.Instance: ${lbmPtr}`);
    if (!lbmPtr.isNull()) {
        const frameTime = lbmPtr.add(316).readU32();
        const recvFrameTime = lbmPtr.add(308).readU32();
        console.log(`    m_uiFrameTime @ +316: ${frameTime}`);
        console.log(`    m_uiRecvNetFrameTime @ +308: ${recvFrameTime}`);
    }
} catch (e) {
    console.log(`[-] Err reading LogicBattleManager.Instance: ${e}`);
}

console.log("\n[*] Done probe.");
