// findfriends_probe.js — trace MLBB friend-ID-search / profile lookups.
//
// Hooks the .ctor of the relevant MTTDProto Cmd + info classes, prints a short
// backtrace for each (=> reveals the SEND path / which module builds the Cmd),
// then dumps the objects a beat later (fields are filled after ctor) including
// winrate (iPVPVictoryScore/Times) and hero fav (mHeroMMR top-N).
//
// raw il2cpp C API, no bridge, no build. run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l findfriends_probe.js --runtime qjs
//
// do: Add friend -> type ID -> "ID search", and open a profile once.

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
    const domain = domainGet();
    const sizeBuf = Memory.alloc(8);
    const assemblies = domainGetAssemblies(domain, sizeBuf);
    const count = sizeBuf.readU64().toNumber();
    const mk = (s) => Memory.allocUtf8String(s);
    for (let i = 0; i < count; i++) {
        const asm = assemblies.add(i * Process.pointerSize).readPointer();
        const img = assemblyGetImage(asm);
        if (img.isNull()) continue;
        const k = classFromName(img, mk(ns), mk(name));
        if (!k.isNull()) return k;
    }
    return null;
}

// first field of MethodInfo == native code pointer (dump_raw.js uses this)
function methodAddr(klass, name, argc) {
    if (!klass) return null;
    const iter = Memory.alloc(8);
    let m = classGetMethods(klass, iter);
    while (!m.isNull()) {
        try {
            if (cstr(methodGetName(m)) === name && methodGetParamCount(m) === argc) {
                return m.readPointer();
            }
        } catch (e) { /* */ }
        m = classGetMethods(klass, iter);
    }
    return null;
}

function sym(addr) {
    try {
        const mod = Process.findModuleByAddress(addr);
        if (mod) return mod.name + "+0x" + addr.sub(mod.base).toString(16);
    } catch (e) { /* */ }
    return addr.toString();
}
// NB: no Thread.backtrace here — full unwinds through il2cpp frames crash the game.
// the immediate return address is enough to identify the caller (the send fn).
function callerAddr(ctx) {
    try { return sym(ctx.returnAddress); } catch (e) { return "?"; }
}

// il2cpp System.String = {klass, monitor, len@0x10, utf16@0x14}
function istr(p) {
    if (p.isNull() || p.toUInt32() < 0x1000) return "";
    try {
        const len = p.add(0x10).readS32();
        if (len <= 0 || len > 64) return "";
        const b = p.add(0x14).readByteArray(len * 2);
        const dv = new DataView(b);
        let s = "";
        for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(i * 2, true));
        return s;
    } catch (e) { return ""; }
}
// Dictionary<uint,uint>: entries@0x18, count@0x20; Entry{hash@0,next@4,k@8,v@0x10} 0x18
function dictU32Top(dict, top) {
    const out = [];
    if (dict.isNull() || dict.toUInt32() < 0x1000) return out;
    try {
        const entries = dict.add(0x18).readPointer();
        const count = dict.add(0x20).readS32();
        if (entries.isNull() || count <= 0 || count > 512) return out;
        const n = Math.min(count, entries.add(0x18).readU32());
        const buf = entries.add(0x20).readByteArray(n * 0x18);
        const dv = new DataView(buf);
        for (let i = 0; i < n; i++) {
            const k = dv.getUint32(i * 0x18 + 8, true);
            const v = dv.getUint32(i * 0x18 + 16, true);
            if (k) out.push([k, v]);
        }
        out.sort((a, b) => b[1] - a[1]);
    } catch (e) { /* */ }
    return out.slice(0, top);
}

const K = {
    CS: findKlass("MTTDProto", "Cmd_Friend_FindFriends_CS"),
    SC: findKlass("MTTDProto", "Cmd_Friend_FindFriends_SC"),
    GCS: findKlass("MTTDProto", "Cmd_Role_GetBaseInfo_CS"),
    GSC: findKlass("MTTDProto", "Cmd_Role_GetBaseInfo_SC"),
    FBI: findKlass("MTTDProto", "FriendBaseInfo"),
    PBI: findKlass("MTTDProto", "PlayerBaseInfo"),
};
console.log("[*] " + Object.keys(K).map((n) => n + "=" + (K[n] ? "ok" : "NULL")).join(" "));

function dumpFbi(p) {
    return {
        uid: (() => { try { return p.add(0x10).readU64().toString(); } catch (e) { return "?"; } })(),
        svr: (() => { try { return p.add(0x18).readU32(); } catch (e) { return 0; } })(),
        name: (() => { try { return istr(p.add(0x20).readPointer()); } catch (e) { return ""; } })(),
        rank: (() => { try { return p.add(0x3c).readU32(); } catch (e) { return 0; } })(),
        win: (() => { try { return p.add(0x70).readU32(); } catch (e) { return 0; } })(),
        games: (() => { try { return p.add(0x74).readU32(); } catch (e) { return 0; } })(),
        fav: (() => { try { return dictU32Top(p.add(0x78).readPointer(), 5); } catch (e) { return []; } })(),
    };
}
function dumpPbi(p) {
    return {
        uid: (() => { try { return p.add(0x10).readU64().toString(); } catch (e) { return "?"; } })(),
        svr: (() => { try { return p.add(0x18).readU32(); } catch (e) { return 0; } })(),
        name: (() => { try { return istr(p.add(0x20).readPointer()); } catch (e) { return ""; } })(),
        rank: (() => { try { return p.add(0x34).readU32(); } catch (e) { return 0; } })(),
        win: (() => { try { return p.add(0x80).readU32(); } catch (e) { return 0; } })(),
        games: (() => { try { return p.add(0x84).readU32(); } catch (e) { return 0; } })(),
        fav: (() => { try { return dictU32Top(p.add(0x88).readPointer(), 5); } catch (e) { return []; } })(),
    };
}
function dumpCS(p) {
    return {
        sName: (() => { try { return istr(p.add(0x10).readPointer()); } catch (e) { return ""; } })(),
        ulUid: (() => { try { return p.add(0x18).readU64().toString(); } catch (e) { return "?"; } })(),
    };
}
function dumpSC(p) {
    const rows = [];
    try {
        const list = p.add(0x10).readPointer();
        const items = list.add(0x10).readPointer();
        const size = list.add(0x18).readS32();
        if (items.isNull() || size <= 0 || size > 32) return rows;
        const n = Math.min(size, items.add(0x18).readU32());
        const dv = new DataView(items.add(0x20).readByteArray(n * 8));
        for (let i = 0; i < n; i++) {
            const q = ptr(dv.getBigUint64(i * 8, true).toString());
            if (!q.isNull()) rows.push(dumpFbi(q));
        }
    } catch (e) { /* */ }
    return rows;
}

const caps = {}; // tag -> [NativePointer,...]
function note(tag, p) { (caps[tag] = caps[tag] || []).push(p); if (caps[tag].length > 64) caps[tag].shift(); }

function hookCtor(tag, klass, trace) {
    if (!klass) return;
    const a = methodAddr(klass, ".ctor", 0);
    if (!a || a.isNull()) { console.log("[!] no ctor for " + tag); return; }
    console.log("[hook] " + tag + " .ctor @" + sym(a));
    Interceptor.attach(a, {
        onEnter(args) {
            note(tag, args[0]);
            if (trace) console.log("[ctor] " + tag + " this=" + args[0] + "  caller=" + callerAddr(this));
        },
    });
}

hookCtor("FCS", K.CS, true);    // friend search request  (SEND path)
hookCtor("FSC", K.SC, true);    // friend search response
hookCtor("GCS", K.GCS, true);   // profile request        (SEND path)
hookCtor("GSC", K.GSC, true);   // profile response
hookCtor("FBI", K.FBI, false);  // per-friend info        (winrate + fav) — noisy, no trace
hookCtor("PBI", K.PBI, false);  // per-player base info   (winrate + fav)

const dumped = new Set();
setInterval(() => {
    for (const tag of Object.keys(caps)) {
        const arr = caps[tag];
        while (arr.length) {
            const p = arr.shift();
            if (p.isNull()) continue;
            const key = tag + p.toString();
            if (dumped.has(key)) continue;
            try {
                let obj = null;
                if (tag === "PBI") obj = dumpPbi(p);
                else if (tag === "FBI") obj = dumpFbi(p);
                else if (tag === "FCS") obj = dumpCS(p);
                else if (tag === "GCS") obj = dumpCS(p);
                else if (tag === "FSC") obj = { friends: dumpSC(p) };
                else if (tag === "GSC") {
                    const b = p.add(0x10).readPointer();
                    obj = b.isNull() ? null : { base: dumpPbi(b) };
                }
                if (!obj) continue;
                // only print once we see real data (fav/win/name)
                const blob = JSON.stringify(obj);
                if (blob.indexOf('"fav":[[') === -1 && blob.indexOf('"name":""') !== -1) continue;
                dumped.add(key);
                console.log(JSON.stringify({ ev: tag, o: obj }));
            } catch (e) { /* */ }
        }
    }
}, 300);

console.log("[*] findfriends_probe running — do the ID search now");
