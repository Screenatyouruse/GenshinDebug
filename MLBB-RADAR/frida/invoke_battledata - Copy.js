// invoke_battledata.js — CALL FriendManagerController.RequestBattleData(uid, svr, 0, 0, null, false)
// for an arbitrary player, then dump the Cmd_Battle_GetBattleData_SC reply.
//
// This is the "function calling" route: the game's own session/auth does the request.
// Verified from IDA: Friends_FriendManagerController__RequestBattleData @ libcsharp+0x4f2b1f4
//   builds Cmd_Battle_GetBattleData_CS{ulUid@0x10,uiSvrId@0x18,iRankType@0x1c,iRankHeroId@0x20}
//   and calls GameReceiveMessage.SendGameData(19030, cmd, 0).
//
// run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l invoke_battledata.js --runtime qjs
//
// EDIT TARGET below (defaults to a uid seen in the logs).

const TARGET_UID = "591841355";  // <-- change me (fresh uid: cached ones are skipped)
const TARGET_SVR = 8357;         // <-- change me
const RANK_TYPES = [0, 1, 2, 3, 4, 5, 6];   // brute-force the season/type selector

const lib = Process.getModuleByName("liblogic.so");
const E = (n, r, a) => new NativeFunction(lib.getExportByName(n), r, a);
const domainGet = E("il2cpp_domain_get", "pointer", []);
const threadAttach = E("il2cpp_thread_attach", "pointer", ["pointer"]);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const classGetMethodFromName = E("il2cpp_class_get_method_from_name", "pointer", ["pointer", "pointer", "int"]);
const runtimeInvoke = E("il2cpp_runtime_invoke", "pointer", ["pointer", "pointer", "pointer", "pointer"]);
const fieldFromName = E("il2cpp_class_get_field_from_name", "pointer", ["pointer", "pointer"]);
const fieldStaticGetValue = E("il2cpp_field_static_get_value", "void", ["pointer", "pointer"]);

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
        const items = list.add(0x10).readPointer(); const size = list.add(0x18).readS32();
        if (items.isNull() || size <= 0 || size > 64) return out;
        const nn = Math.min(size, items.add(0x18).readU32());
        const dv = new DataView(items.add(0x20).readByteArray(nn * 8));
        for (let i = 0; i < nn; i++) { const q = ptr(dv.getBigUint64(i * 8, true).toString()); if (!q.isNull()) out.push(q); }
    } catch (e) { }
    return out;
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
// Dictionary<uint,uint>: Entry{hash@0,next@4,key@8,value@0xC} stride 0x10
function dictU32Top(dict, top) {
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
function u32(p, o, d) { try { return p.add(o).readU32(); } catch (e) { return d; } }
function u64(p, o, d) { try { return p.add(o).readU64().toString(); } catch (e) { return d; } }

function dumpSC(p) {
    const base = (() => { try { return p.add(0x68).readPointer(); } catch (e) { return ptr(0); } })();
    const heros = listPtrs((() => { try { return p.add(0x98).readPointer(); } catch (e) { return ptr(0); } })())
        .map((h) => ({ hero: u32(h, 0x10, 0), total: u32(h, 0x14, 0), win: u32(h, 0x18, 0) }))
        .sort((a, b) => b.total - a.total).slice(0, 10);
    const byType = [];
    try {
        const bd = p.add(0xa8).readPointer();
        const entries = bd.add(0x18).readPointer(); const cnt = bd.add(0x20).readS32();
        if (!entries.isNull() && cnt > 0 && cnt <= 64) {
            const nn = Math.min(cnt, entries.add(0x18).readU32());
            const dv = new DataView(entries.add(0x20).readByteArray(nn * 0x18));
            for (let i = 0; i < nn; i++) {
                const k = dv.getUint32(i * 0x18 + 8, true);
                const vp = ptr(dv.getBigUint64(i * 0x18 + 16, true).toString());
                if (!vp.isNull()) byType.push({ type: k, total: u32(vp, 0x10, 0), win: u32(vp, 0x14, 0), rankTotal: u32(vp, 0x58, 0) });
            }
        }
    } catch (e) { }
    return {
        total: u32(p, 0x10, 0), win: u32(p, 0x14, 0), mvp: u32(p, 0x24, 0), kda: u32(p, 0x3c, 0),
        popularity: u32(p, 0xd8, 0),
        rankType: u32(p, 0xb8, 0), rankHero: u32(p, 0xbc, 0),
        byType,
        base: (base.isNull() || base.toUInt32() < 0x1000) ? null : {
            uid: u64(base, 0x10, "?"), svr: u32(base, 0x18, 0), name: (() => { try { return istr(base.add(0x20).readPointer()); } catch (e) { return ""; } })(),
            rank: u32(base, 0x34, 0), win: u32(base, 0x80, 0), games: u32(base, 0x84, 0),
            fav: dictU32Top((() => { try { return base.add(0x88).readPointer(); } catch (e) { return ptr(0); } })(), 5),
        },
        useCount: dictU32Top((() => { try { return p.add(0xe0).readPointer(); } catch (e) { return ptr(0); } })(), 6),
        lastBuy: listU32((() => { try { return p.add(0x78).readPointer(); } catch (e) { return ptr(0); } })()),
        heros,
    };
}

// hook the SC ctor so we see the reply
const K = { SC: findKlass("MTTDProto", "Cmd_Battle_GetBattleData_SC") };
if (K.SC) {
    const iter = Memory.alloc(8);
    let m = E("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"])(K.SC, iter);
    const mName = E("il2cpp_method_get_name", "pointer", ["pointer"]);
    const mPc = E("il2cpp_method_get_param_count", "uint32", ["pointer"]);
    while (!m.isNull()) {
        try {
            if (cstr(mName(m)) === ".ctor" && mPc(m) === 0) {
                const a = m.readPointer();
                console.log("[hook] SC .ctor @" + a);
                Interceptor.attach(a, { onEnter(args) { const o = args[0]; setTimeout(() => { try { console.log(JSON.stringify({ ev: "SC", o: dumpSC(o) })); } catch (e) { } }, 30); } });
                break;
            }
        } catch (e) { }
        m = E("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"])(K.SC, iter);
    }
}

// call RequestBattleData
threadAttach(domainGet());
const klass = findKlass("Friends", "FriendManagerController");
console.log("[*] FriendManagerController=" + (klass ? "ok" : "NULL"));
if (klass) {
    const f = fieldFromName(klass, Memory.allocUtf8String("_instance"));
    const slot = Memory.alloc(8);
    if (f.isNull()) { console.log("[!] no _instance field"); }
    else {
        fieldStaticGetValue(f, slot);
        const inst = slot.readPointer();
        console.log("[*] instance=" + inst);
        const method = classGetMethodFromName(klass, Memory.allocUtf8String("RequestBattleData"), 6);
        console.log("[*] RequestBattleData=" + method);
        if (!inst.isNull() && !method.isNull()) {
            const pUid = Memory.alloc(8); pUid.writeU64(uint64(TARGET_UID));
            const pSvr = Memory.alloc(4); pSvr.writeU32(TARGET_SVR);
            const pRankType = Memory.alloc(4);
            const pRankHero = Memory.alloc(4); pRankHero.writeU32(0);
            const pStr = Memory.alloc(8); pStr.writePointer(ptr(0));
            const pBool = Memory.alloc(8); pBool.writeU8(0);
            const args = Memory.alloc(8 * 6);
            [pUid, pSvr, pRankType, pRankHero, pStr, pBool].forEach((p, i) => args.add(i * 8).writePointer(p));
            const exc = Memory.alloc(8);
            for (const rt of RANK_TYPES) {
                pRankType.writeU32(rt);
                exc.writePointer(ptr(0));
                console.log("[*] RequestBattleData(uid=" + TARGET_UID + ", svr=" + TARGET_SVR + ", rankType=" + rt + ")");
                const r = runtimeInvoke(method, inst, args, exc);
                const e = exc.readPointer();
                if (!e.isNull()) console.log("[!] rankType=" + rt + " exc=" + (() => { try { return istr(e.add(0x20).readPointer()); } catch (x) { return "?"; } })());
            }
        }
    }
}
console.log("[*] done — watch for {\"ev\":\"SC\",...}");
