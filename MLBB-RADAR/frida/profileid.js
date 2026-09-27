// profileid.js — print the uid + server of whatever profile you OPEN.
// Hooks the ctor of the profile request Cmds and reads ulUid@0x10 / uiSvrId@0x18
// once the caller fills them. Use the printed values with invoke_battledata.js.
//
// run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l profileid.js --runtime qjs
// then just tap players' profiles.

const lib = Process.getModuleByName("liblogic.so");
const E = (n, r, a) => new NativeFunction(lib.getExportByName(n), r, a);
const domainGet = E("il2cpp_domain_get", "pointer", []);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const classGetMethods = E("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"]);
const methodGetName = E("il2cpp_method_get_name", "pointer", ["pointer"]);
const methodGetParamCount = E("il2cpp_method_get_param_count", "uint32", ["pointer"]);

function cstr(p) { return p.isNull() ? "" : p.readUtf8String(); }
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
function firstCtor(klass) {
    if (!klass) return null;
    const iter = Memory.alloc(8);
    let m = classGetMethods(klass, iter);
    while (!m.isNull()) {
        try { if (cstr(methodGetName(m)) === ".ctor") return m.readPointer(); } catch (e) { }
        m = classGetMethods(klass, iter);
    }
    return null;
}
function u32(p, o) { try { return p.add(o).readU32(); } catch (e) { return 0; } }
function u64(p, o) { try { return p.add(o).readU64().toString(); } catch (e) { return "0"; } }

const TARGETS = [
    ["Cmd_Role_GetPlayerBaseInfo_CS", "profile"],
    ["Cmd_Role_GetBaseInfo_CS", "profile2"],
    ["Cmd_Battle_GetBattleData_CS", "battledata"],
];
const seen = new Set();
const caps = [];
for (const [name, tag] of TARGETS) {
    const k = findKlass("MTTDProto", name);
    if (!k) { console.log("[!] " + name + " not found"); continue; }
    const a = firstCtor(k);
    if (!a) { console.log("[!] no ctor " + name); continue; }
    Interceptor.attach(a, { onEnter(args) { caps.push({ tag, p: args[0] }); if (caps.length > 64) caps.shift(); } });
    console.log("[hook] " + name + " (" + tag + ")");
}

setInterval(() => {
    for (const c of caps.splice(0)) {
        try {
            const uid = u64(c.p, 0x10);
            const svr = u32(c.p, 0x18);
            if (uid === "0") continue;
            const key = c.tag + ":" + uid + ":" + svr;
            if (seen.has(key)) continue;
            seen.add(key);
            console.log("[target] " + c.tag + "  uid=" + uid + "  svr=" + svr +
                "   ->  const TARGET_UID = \"" + uid + "\"; const TARGET_SVR = " + svr + ";");
        } catch (e) { }
    }
}, 200);

console.log("[*] profileid running — open profiles; uid/svr printed per visit");
