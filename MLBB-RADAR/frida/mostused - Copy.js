// mostused.js — dump FriendBaseInfo.vMostUseHeroIds@0x1a8 (the player's most-used
// heroes, i.e. the 3 portraits on a profile). Also prints mHeroMMR@0x78 (fixed stride).
//
// run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l mostused.js --runtime qjs
// then open a profile / friend list / search a uid.

const lib = Process.getModuleByName("liblogic.so");
const E = (n, r, a) => new NativeFunction(lib.getExportByName(n), r, a);
const domainGet = E("il2cpp_domain_get", "pointer", []);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const classGetMethods = E("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"]);
const methodGetName = E("il2cpp_method_get_name", "pointer", ["pointer"]);

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
function istr(p) {
    if (p.isNull() || p.toUInt32() < 0x1000) return "";
    try {
        const len = p.add(0x10).readS32();
        if (len <= 0 || len > 64) return "";
        const b = p.add(0x14).readByteArray(len * 2); const dv = new DataView(b); let s = "";
        for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(i * 2, true));
        return s;
    } catch (e) { return ""; }
}
function listU32(list) {
    const out = [];
    if (list.isNull() || list.toUInt32() < 0x1000) return out;
    try {
        const items = list.add(0x10).readPointer(); const size = list.add(0x18).readS32();
        if (items.isNull() || size <= 0 || size > 64) return out;
        const nn = Math.min(size, items.add(0x18).readU32());
        const dv = new DataView(items.add(0x20).readByteArray(nn * 4));
        for (let i = 0; i < nn; i++) out.push(dv.getUint32(i * 4, true));
    } catch (e) { }
    return out;
}
function dictU32Top(dict, top) {   // Dict<uint,uint> stride 0x10
    const out = [];
    if (dict.isNull() || dict.toUInt32() < 0x1000) return out;
    try {
        const entries = dict.add(0x18).readPointer(); const count = dict.add(0x20).readS32();
        if (entries.isNull() || count <= 0 || count > 512) return out;
        const nn = Math.min(count, entries.add(0x18).readU32());
        const dv = new DataView(entries.add(0x20).readByteArray(nn * 0x10));
        for (let i = 0; i < nn; i++) { const k = dv.getUint32(i * 0x10 + 8, true); const v = dv.getUint32(i * 0x10 + 12, true); if (k) out.push([k, v]); }
        out.sort((a, b) => b[1] - a[1]);
    } catch (e) { }
    return out.slice(0, top);
}
function u32(p, o) { try { return p.add(o).readU32(); } catch (e) { return 0; } }
function u64(p, o) { try { return p.add(o).readU64().toString(); } catch (e) { return "0"; } }

for (const nm of ["FriendBaseInfo", "PlayerBaseInfo"]) {
    const k = findKlass("MTTDProto", nm);
    const a = firstCtor(k);
    if (!k || !a) { console.log("[!] " + nm + " not found"); continue; }
    console.log("[hook] " + nm + " .ctor");
    const isFbi = (nm === "FriendBaseInfo");
    const caps = [];
    Interceptor.attach(a, { onEnter(args) { caps.push(args[0]); if (caps.length > 128) caps.shift(); } });
    setInterval(() => {
        for (const p of caps.splice(0)) {
            try {
                const uid = u64(p, 0x10);
                if (uid === "0") continue;
                if (isFbi) {
                    const mostUse = listU32((() => { try { return p.add(0x1a8).readPointer(); } catch (e) { return ptr(0); } })());
                    const fav = dictU32Top((() => { try { return p.add(0x78).readPointer(); } catch (e) { return ptr(0); } })(), 5);
                    if (mostUse.length || fav.length) {
                        console.log(JSON.stringify({ ev: "FriendBaseInfo", uid, svr: u32(p, 0x18), name: istr((() => { try { return p.add(0x20).readPointer(); } catch (e) { return ptr(0); } })()), mostUse, fav }));
                    }
                }
            } catch (e) { }
        }
    }, 200);
}

console.log("[*] mostused running — open a profile / friend list now");
