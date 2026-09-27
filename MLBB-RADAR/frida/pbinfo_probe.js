// pbinfo_probe.js — capture the reply to Cmd_Role_GetPlayerBaseInfo_CS (the OTHER
// player's profile fetch). cmdspy missed it (probably a ctor with params). This hooks
// the ctor(s) regardless of arg count, lists candidate class names, and dumps whatever
// PlayerBaseInfo it finds inside the object.
//
// run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l pbinfo_probe.js --runtime qjs
// then open ANOTHER player's profile. no backtrace (crash-safe).

const lib = Process.getModuleByName("liblogic.so");
const E = (n, r, a) => new NativeFunction(lib.getExportByName(n), r, a);
const domainGet = E("il2cpp_domain_get", "pointer", []);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const imageGetClassCount = E("il2cpp_image_get_class_count", "uint32", ["pointer"]);
const imageGetClass = E("il2cpp_image_get_class", "pointer", ["pointer", "uint32"]);
const classGetName = E("il2cpp_class_get_name", "pointer", ["pointer"]);
const classGetNamespace = E("il2cpp_class_get_namespace", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const classGetMethods = E("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"]);
const methodGetName = E("il2cpp_method_get_name", "pointer", ["pointer"]);
const methodGetParamCount = E("il2cpp_method_get_param_count", "uint32", ["pointer"]);

function cstr(p) { return p.isNull() ? "" : p.readUtf8String(); }
function sym(a) { try { const m = Process.findModuleByAddress(a); if (m) return m.name + "+0x" + a.sub(m.base).toString(16); } catch (e) { } return a.toString(); }
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
// first method named `name`, ANY param count
function firstMethod(klass, name) {
    if (!klass) return null;
    const iter = Memory.alloc(8);
    let m = classGetMethods(klass, iter);
    while (!m.isNull()) {
        try { if (cstr(methodGetName(m)) === name) return m.readPointer(); } catch (e) { }
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
function dictU32Top(dict, top) {
    const out = [];
    if (dict.isNull() || dict.toUInt32() < 0x1000) return out;
    try {
        const entries = dict.add(0x18).readPointer(); const count = dict.add(0x20).readS32();
        if (entries.isNull() || count <= 0 || count > 512) return out;
        const nn = Math.min(count, entries.add(0x18).readU32());
        const dv = new DataView(entries.add(0x20).readByteArray(nn * 0x18));
        for (let i = 0; i < nn; i++) { const k = dv.getUint32(i * 0x18 + 8, true); const v = dv.getUint32(i * 0x18 + 16, true); if (k) out.push([k, v]); }
        out.sort((a, b) => b[1] - a[1]);
    } catch (e) { }
    return out.slice(0, top);
}
function u32(p, o, d) { try { return p.add(o).readU32(); } catch (e) { return d; } }
function u64(p, o, d) { try { return p.add(o).readU64().toString(); } catch (e) { return d; } }

function dumpPbi(p) {
    return {
        uid: u64(p, 0x10, "?"), svr: u32(p, 0x18, 0), name: (() => { try { return istr(p.add(0x20).readPointer()); } catch (e) { return ""; } })(),
        rank: u32(p, 0x34, 0), win: u32(p, 0x80, 0), games: u32(p, 0x84, 0),
        fav: (() => { try { return dictU32Top(p.add(0x88).readPointer(), 5); } catch (e) { return []; } })(),
    };
}

// --- list candidate class names (ns.name) for orientation ---
const pk = findKlass("MTTDProto", "PlayerBaseInfo");
const want = [];
for (const [imgIdx, img] of []) { /* noop */ }
{
    const d = domainGet(); const sb = Memory.alloc(8);
    const asms = domainGetAssemblies(d, sb); const n = sb.readU64().toNumber();
    for (let i = 0; i < n; i++) {
        let img;
        try { img = assemblyGetImage(asms.add(i * Process.pointerSize).readPointer()); } catch (e) { continue; }
        if (img.isNull()) continue;
        let cc = 0; try { cc = imageGetClassCount(img); } catch (e) { continue; }
        for (let j = 0; j < cc; j++) {
            let k; try { k = imageGetClass(img, j); } catch (e) { continue; }
            if (k.isNull()) continue;
            let nm = ""; try { nm = cstr(classGetName(k)); } catch (e) { continue; }
            if (/GetPlayerBaseInfo|PlayerBaseInfo/.test(nm)) {
                let ns = ""; try { ns = cstr(classGetNamespace(k)); } catch (e) { }
                want.push(ns + "." + nm);
            }
        }
    }
}
console.log("[*] candidates: " + want.join(", "));
console.log("[*] PlayerBaseInfo klass: " + (pk ? pk.handle : "NULL"));

const SC = findKlass("MTTDProto", "Cmd_Role_GetPlayerBaseInfo_SC");
const CS = findKlass("MTTDProto", "Cmd_Role_GetPlayerBaseInfo_CS");
const GSC = findKlass("MTTDProto", "Cmd_Role_GetBaseInfo_SC");
console.log("[*] SC=" + (SC ? "ok" : "NULL") + " CS=" + (CS ? "ok" : "NULL") + " GSC=" + (GSC ? "ok" : "NULL"));

const caps = [];
function hookAny(klass, tag, trace) {
    if (!klass) return;
    const a = firstMethod(klass, ".ctor");
    if (!a || a.isNull()) { console.log("[!] no .ctor " + tag); return; }
    console.log("[hook] " + tag + " .ctor @" + sym(a));
    Interceptor.attach(a, {
        onEnter(args) {
            caps.push(args[0]);
            if (caps.length > 32) caps.shift();
            if (trace) console.log("[ctor] " + tag + " caller=" + (() => { try { return sym(this.returnAddress); } catch (e) { return "?"; } })());
        },
    });
}
hookAny(SC, "GetPlayerBaseInfo_SC", true);
hookAny(GSC, "GetBaseInfo_SC", true);

// find a PlayerBaseInfo pointer anywhere in the first 0x100 bytes of obj
function findPbi(obj) {
    for (let off = 8; off <= 0x100; off += 8) {
        try {
            const p = obj.add(off).readPointer();
            if (!p.isNull() && p.toUInt32() > 0x1000 && pk && p.readPointer().equals(pk.handle)) return { off, p };
        } catch (e) { }
    }
    return null;
}

const dumped = new Set();
setInterval(() => {
    try {
        for (const obj of caps.splice(0)) {
            const key = obj.toString();
            if (dumped.has(key)) continue;
            dumped.add(key);
            const hit = findPbi(obj);
            if (hit) console.log(JSON.stringify({ ev: "PBI_FOUND", at: "0x" + hit.off.toString(16), pbi: dumpPbi(hit.p) }));
            else {
                // no PBI member: hex dump the head so we can see the layout
                let hex = "";
                try { hex = obj.readByteArray(0x80); } catch (e) { }
                if (hex) {
                    const b = new Uint8Array(hex); let s = "";
                    for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
                    console.log(JSON.stringify({ ev: "RAW", hex: s }));
                }
            }
        }
    } catch (e) { }
}, 250);

console.log("[*] pbinfo_probe running — open ANOTHER player's profile now");
