// battledata_probe.js — dump Cmd_Battle_GetBattleData_SC (the profile "battle
// stats" reply): winrate + PlayerBaseInfo (mHeroMMR = Hero Fav) + vecHeroDatas
// (per-hero usage). Cmd_Battle_GetBattleData_CS is target-addressable:
//   ulUid@0x10, uiSvrId@0x18, iRankType@0x1c, iRankHeroId@0x20
//
// run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l battledata_probe.js --runtime qjs
// then open a profile (and its Favorites/battlefield tab). no backtrace (that crashes the game).

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
function sym(a) { try { const m = Process.findModuleByAddress(a); if (m) return m.name + "+0x" + a.sub(m.base).toString(16); } catch (e) { } return a.toString(); }
function findKlass(ns, name) {
    const domain = domainGet(); const sb = Memory.alloc(8);
    const asms = domainGetAssemblies(domain, sb); const n = sb.readU64().toNumber();
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
        try { if (cstr(methodGetName(m)) === name && methodGetParamCount(m) === argc) return m.readPointer(); } catch (e) { }
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
function listPtrs(list) {
    const out = [];
    if (list.isNull() || list.toUInt32() < 0x1000) return out;
    try {
        const items = list.add(0x10).readPointer();
        const size = list.add(0x18).readS32();
        if (items.isNull() || size <= 0 || size > 64) return out;
        const nn = Math.min(size, items.add(0x18).readU32());
        const dv = new DataView(items.add(0x20).readByteArray(nn * 8));
        for (let i = 0; i < nn; i++) { const q = ptr(dv.getBigUint64(i * 8, true).toString()); if (!q.isNull()) out.push(q); }
    } catch (e) { }
    return out;
}
function dictU32Top(dict, top) {
    const out = [];
    if (dict.isNull() || dict.toUInt32() < 0x1000) return out;
    try {
        const entries = dict.add(0x18).readPointer();
        const count = dict.add(0x20).readS32();
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

const K = {
    CS: findKlass("MTTDProto", "Cmd_Battle_GetBattleData_CS"),
    SC: findKlass("MTTDProto", "Cmd_Battle_GetBattleData_SC"),
    PBI: findKlass("MTTDProto", "PlayerBaseInfo"),
    HBD: findKlass("MTTDProto", "HeroBattleData"),
};
console.log("[*] " + Object.keys(K).map((n) => n + "=" + (K[n] ? "ok" : "NULL")).join(" "));

function dumpPbi(p) {
    const b = p.add(0x68).readPointer(); // SC.stBase
    if (b.isNull() || b.toUInt32() < 0x1000) return null;
    return {
        uid: u64(b, 0x10, "?"), svr: u32(b, 0x18, 0), name: (() => { try { return istr(b.add(0x20).readPointer()); } catch (e) { return ""; } })(),
        rank: u32(b, 0x34, 0), win: u32(b, 0x80, 0), games: u32(b, 0x84, 0),
        fav: (() => { try { return dictU32Top(b.add(0x88).readPointer(), 5); } catch (e) { return []; } })(),
    };
}
function dumpHeros(p) {
    const rows = [];
    for (const h of listPtrs(p.add(0x98).readPointer())) {
        rows.push({ hero: u32(h, 0x10, 0), total: u32(h, 0x14, 0), win: u32(h, 0x18, 0), skin: u32(h, 0x1c, 0) });
    }
    rows.sort((a, b) => b.total - a.total);
    return rows.slice(0, 10);
}
function dumpSC(p) {
    return {
        total: u32(p, 0x10, 0), win: u32(p, 0x14, 0), weekTotal: u32(p, 0x18, 0), weekMax: u32(p, 0x1c, 0),
        mvp: u32(p, 0x24, 0), kda: u32(p, 0x3c, 0), aveHurt: u32(p, 0x48, 0),
        svr: u32(p, 0x60, 0), seasonMaxRank: u32(p, 0x8c, 0), popularity: u32(p, 0xd8, 0),
        base: dumpPbi(p), heros: dumpHeros(p),
    };
}

const caps = {};
function hookCtor(tag, klass, trace) {
    if (!klass) return;
    const a = methodAddr(klass, ".ctor", 0);
    if (!a || a.isNull()) { console.log("[!] no ctor " + tag); return; }
    console.log("[hook] " + tag + " .ctor @" + sym(a));
    Interceptor.attach(a, {
        onEnter(args) {
            (caps[tag] = caps[tag] || []).push(args[0]);
            if (caps[tag].length > 32) caps[tag].shift();
            if (trace) console.log("[ctor] " + tag + " caller=" + (() => { try { return sym(this.returnAddress); } catch (e) { return "?"; } })());
        },
    });
}
hookCtor("CS", K.CS, true);
hookCtor("SC", K.SC, true);

const dumped = new Set();
setInterval(() => {
    try {
        for (const p of (caps.SC || []).splice(0)) {
            const key = p.toString();
            if (dumped.has(key)) continue;
            const o = dumpSC(p);
            if (!o.base && !o.total) continue;
            dumped.add(key);
            console.log(JSON.stringify({ ev: "BATTLEDATA", o }));
        }
        for (const p of (caps.CS || []).splice(0)) {
            console.log(JSON.stringify({ ev: "REQ", uid: u64(p, 0x10, "?"), svr: u32(p, 0x18, 0), rankType: u32(p, 0x1c, 0), rankHero: u32(p, 0x20, 0) }));
        }
    } catch (e) { }
}, 250);

console.log("[*] battledata_probe running — open a profile + Favorites tab now");
