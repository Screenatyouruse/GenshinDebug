// replywatch.js — PASSIVE. Logs the game's own profile / friend message traffic.
// No injected calls, no patching: hook ctors, dump objects once fields are filled.
//
// run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l replywatch.js --runtime qjs -q
//
// then touch things (each prints one JSON line):
//   - open your own profile        -> Cmd_Battle_GetBattleData_CS/SC + FriendBaseInfo/PlayerBaseInfo
//   - add friend -> ID search      -> Cmd_Friend_FindFriends_CS/SC + FriendBaseInfo (mostUse!)
//   - open friend list             -> FriendBaseInfo per row (uid/name/rank; mostUse when pushed)
//
// JSON events: {t, ev, o}. ev = CS class / SC class / FriendBaseInfo / PlayerBaseInfo.
// First field of a MethodInfo = native code pointer (used for the hook).

const lib = Process.getModuleByName("liblogic.so");
const E = (n, r, a) => new NativeFunction(lib.getExportByName(n), r, a);

const domainGet = E("il2cpp_domain_get", "pointer", []);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const classGetMethods = E("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"]);
const methodGetName = E("il2cpp_method_get_name", "pointer", ["pointer"]);
const methodGetParamCount = E("il2cpp_method_get_param_count", "uint32", ["pointer"]);
const imageGetClassCount = E("il2cpp_image_get_class_count", "uint32", ["pointer"]);
const imageGetClass = E("il2cpp_image_get_class", "pointer", ["pointer", "uint32"]);
const classGetName = E("il2cpp_class_get_name", "pointer", ["pointer"]);

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
function ctorAddr(klass) {
    if (!klass) return null;
    const iter = Memory.alloc(8);
    let m = classGetMethods(klass, iter);
    while (!m.isNull()) {
        try { if (methodGetParamCount(m) === 0 && cstr(methodGetName(m)) === ".ctor") return m.readPointer(); } catch (e) { /* */ }
        m = classGetMethods(klass, iter);
    }
    return null;
}
function istr(p) {
    if (p.isNull() || p.toUInt32() < 0x1000) return "";
    try {
        const len = p.add(0x10).readS32();
        if (len <= 0 || len > 96) return "";
        const b = p.add(0x14).readByteArray(len * 2); const dv = new DataView(b); let s = "";
        for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(i * 2, true));
        return s;
    } catch (e) { return ""; }
}
function listPtrs(list, cap) {
    const out = [];
    if (list.isNull() || list.toUInt32() < 0x1000) return out;
    try {
        const items = list.add(0x10).readPointer(); const size = list.add(0x18).readS32();
        if (items.isNull() || size <= 0 || size > (cap || 512)) return out;
        const nn = Math.min(size, items.add(0x18).readU32());
        const dv = new DataView(items.add(0x20).readByteArray(nn * 8));
        for (let i = 0; i < nn; i++) { const q = ptr(dv.getBigUint64(i * 8, true).toString()); if (!q.isNull()) out.push(q); }
    } catch (e) { /* */ }
    return out;
}
function listU32(list, cap) {  // List<u32> -> values
    const out = [];
    if (list.isNull() || list.toUInt32() < 0x1000) return out;
    try {
        const items = list.add(0x10).readPointer(); const size = list.add(0x18).readS32();
        if (items.isNull() || size <= 0 || size > (cap || 512)) return out;
        const nn = Math.min(size, items.add(0x18).readU32());
        const dv = new DataView(items.add(0x20).readByteArray(nn * 4));
        for (let i = 0; i < nn; i++) out.push(dv.getUint32(i * 4, true));
    } catch (e) { /* */ }
    return out;
}
function dictU32Top(dict, top) {  // Dictionary<uint,uint> stride 0x10
    const out = [];
    if (dict.isNull() || dict.toUInt32() < 0x1000) return out;
    try {
        const entries = dict.add(0x18).readPointer(); const count = dict.add(0x20).readS32();
        if (entries.isNull() || count <= 0 || count > 1024) return out;
        const nn = Math.min(count, entries.add(0x18).readU32());
        const dv = new DataView(entries.add(0x20).readByteArray(nn * 0x10));
        for (let i = 0; i < nn; i++) { const k = dv.getUint32(i * 0x10 + 8, true); const v = dv.getUint32(i * 0x10 + 12, true); if (k) out.push([k, v]); }
        out.sort((a, b) => b[1] - a[1]);
    } catch (e) { /* */ }
    return out.slice(0, top || 8);
}
function u32(p, o) { try { return p.add(o).readU32(); } catch (e) { return 0; } }
function u64(p, o) { try { return p.add(o).readU64().toString(); } catch (e) { return "0"; } }
function sptr(p, o) { try { return p.add(o).readPointer(); } catch (e) { return ptr(0); } }

const K = {
    BattleCS: findKlass("MTTDProto", "Cmd_Battle_GetBattleData_CS"),
    BattleSC: findKlass("MTTDProto", "Cmd_Battle_GetBattleData_SC"),
    FindCS: findKlass("MTTDProto", "Cmd_Friend_FindFriends_CS"),
    FindSC: findKlass("MTTDProto", "Cmd_Friend_FindFriends_SC"),
    GetBaseCS: findKlass("MTTDProto", "Cmd_Role_GetPlayerBaseInfo_CS"),
    FBI: findKlass("MTTDProto", "FriendBaseInfo"),
    PBI: findKlass("MTTDProto", "PlayerBaseInfo"),
};
console.log("[rw] klass " + Object.keys(K).map((n) => n + "=" + (K[n] ? "ok" : "NULL")).join(" "));

// ---- dumps
function dumpFindCS(p) { return { sName: istr(sptr(p, 0x10)), uid: u64(p, 0x18) }; }
function dumpBattleCS(p) { return { uid: u64(p, 0x10), svr: u32(p, 0x18), rankType: u32(p, 0x1c), rankHero: u32(p, 0x20) }; }
function dumpGetBaseCS(p) { return { uid: u64(p, 0x10), svr: u32(p, 0x18) }; }
function dumpFBI(p) {
    return {
        uid: u64(p, 0x10), svr: u32(p, 0x18), name: istr(sptr(p, 0x20)),
        rank: u32(p, 0x3c), win: u32(p, 0x70), games: u32(p, 0x74),
        fav: dictU32Top(sptr(p, 0x78), 5), mostUse: listU32(sptr(p, 0x1a8), 512),
    };
}
function dumpPBI(p) {
    return {
        uid: u64(p, 0x10), svr: u32(p, 0x18), name: istr(sptr(p, 0x20)),
        rank: u32(p, 0x34), win: u32(p, 0x80), games: u32(p, 0x84), fav: dictU32Top(sptr(p, 0x88), 5),
    };
}
function dumpBattleSC(p) {
    const base = sptr(p, 0x68);
    const byType = [];
    try {
        const bd = sptr(p, 0xa8);
        const entries = bd.add(0x18).readPointer(); const cnt = bd.add(0x20).readS32();
        if (!entries.isNull() && cnt > 0 && cnt <= 128) {
            const nn = Math.min(cnt, entries.add(0x18).readU32());
            const dv = new DataView(entries.add(0x20).readByteArray(nn * 0x18));
            for (let i = 0; i < nn; i++) {
                const k = dv.getUint32(i * 0x18 + 8, true);
                const vp = ptr(dv.getBigUint64(i * 0x18 + 16, true).toString());
                if (!vp.isNull()) byType.push({ type: k, total: u32(vp, 0x10), win: u32(vp, 0x14) });
            }
        }
    } catch (e) { /* */ }
    return {
        total: u32(p, 0x10), win: u32(p, 0x14), week: u32(p, 0x18), mvp: u32(p, 0x24),
        reputation: u32(p, 0x20), seasonMaxRank: u32(p, 0x8c), popularity: u32(p, 0xd8),
        scRankType: u32(p, 0xb8), scRankHero: u32(p, 0xbc),   // echo: which tab this payload answers
        battleRecords: listPtrs(sptr(p, 0xa0), 64).length,
        byType,
        base: (base.isNull() || base.toUInt32() < 0x1000) ? null : dumpPBI(base),
        useCount: dictU32Top(sptr(p, 0xe0), 8),
        heros: listPtrs(sptr(p, 0x98), 256).map((h) => {   // HeroBattleData: total/win + HeroMMRNew@0x28
            const m = sptr(h, 0x28);
            return {
                hero: u32(h, 0x10), total: u32(h, 0x14), win: u32(h, 0x18), skin: u32(h, 0x1c),
                mmr: (m.isNull() || m.toUInt32() < 0x1000) ? 0 : u32(m, 0x14),
                mmrHigh: (m.isNull() || m.toUInt32() < 0x1000) ? 0 : u32(m, 0x10),
            };
        }).slice(0, 60),
    };
}
// Cmd_LBSMMR_Info_SC.mHeroMMR@0x10 : Dictionary<u32, HeroMMRNew> (ref value -> stride 0x18)
function dictHeroMMR(dict) {
    const out = [];
    if (dict.isNull() || dict.toUInt32() < 0x1000) return out;
    try {
        const entries = dict.add(0x18).readPointer(); const count = dict.add(0x20).readS32();
        if (entries.isNull() || count <= 0 || count > 1024) return out;
        const nn = Math.min(count, entries.add(0x18).readU32());
        const dv = new DataView(entries.add(0x20).readByteArray(nn * 0x18));
        for (let i = 0; i < nn; i++) {
            const k = dv.getUint32(i * 0x18 + 8, true);
            const vp = ptr(dv.getBigUint64(i * 0x18 + 16, true).toString());
            if (k && !vp.isNull()) out.push({ hero: k, cur: u32(vp, 0x14), high: u32(vp, 0x10), ability: u32(vp, 0x18) });
        }
        out.sort((a, b) => b.cur - a.cur);
    } catch (e) { /* */ }
    return out.slice(0, 15);
}
// Cmd_Get_HeroMMR_Component_SC: uiRankType@0x10, iHeroId@0x14, stRoleKey@0x18, stHeroMMRComponent@0x20
function dumpMMRComp(p) {
    const c = sptr(p, 0x20);
    const out = { rankType: u32(p, 0x10), heroId: u32(p, 0x14), newMMR: 0, arenaMMR: 0 };
    if (!c.isNull() && c.toUInt32() > 0x1000) {
        out.newMMR = u32(sptr(c, 0x10), 0x10);      // HeroMMRComponentNewMMR.iMMR
        out.arenaMMR = u32(sptr(c, 0x18), 0x10);    // HeroMMRComponentArenaMatch.iMMR
    }
    return out;
}

// ---- capture + deferred dump (fields fill AFTER the ctor)
const caps = {}; const seen = new Set();
function hook(tag, klass, trace) {
    if (!klass) { console.log("[rw] no klass for " + tag); return; }
    const a = ctorAddr(klass);
    if (!a) { console.log("[rw] no ctor for " + tag); return; }
    console.log("[rw] hook " + tag + " @ " + a);
    Interceptor.attach(a, {
        onEnter(args) {
            const p = args[0];
            if (!p.isNull()) (caps[tag] = caps[tag] || []).push(p);
            if (trace) console.log(JSON.stringify({ t: Date.now(), ev: tag + "_ctor", p: p.toString() }));
        },
    });
}
hook("BattleCS", K.BattleCS, false);
hook("FindCS", K.FindCS, false);
hook("GetBaseCS", K.GetBaseCS, false);
hook("BattleSC", K.BattleSC, false);
hook("FindSC", K.FindSC, false);
hook("FriendBaseInfo", K.FBI, false);
hook("PlayerBaseInfo", K.PBI, false);

// ---- generic MTTDProto message spy: every Cmd_* ctor logs once per second, and the
//      classes in WATCH get their objects dumped (ctor-independent discovery).
const WATCH = {
    Cmd_LBSMMR_Info_SC: "LBSMMR",                 // mHeroMMR: Dict<u32,HeroMMRNew>
    Cmd_Get_HeroMMR_Component_SC: "MMRComp",      // per-hero MMR component
};
let cmdHooks = 0;
{
    const d = domainGet(); const sb = Memory.alloc(8);
    const asms = domainGetAssemblies(d, sb); const n = sb.readU64().toNumber();
    const last = {};
    for (let i = 0; i < n; i++) {
        let img; try { img = assemblyGetImage(asms.add(i * Process.pointerSize).readPointer()); } catch (e) { continue; }
        if (img.isNull()) continue;
        let cc = 0; try { cc = imageGetClassCount(img); } catch (e) { continue; }
        for (let j = 0; j < cc; j++) {
            let k; try { k = imageGetClass(img, j); } catch (e) { continue; }
            if (k.isNull()) continue;
            let name = ""; try { name = cstr(classGetName(k)); } catch (e) { continue; }
            if (!/^Cmd_/.test(name) || /Frame/.test(name)) continue;
            const a = ctorAddr(k);
            if (!a || a.isNull()) continue;
            const tag = WATCH[name];
            try {
                Interceptor.attach(a, {
                    onEnter(args) {
                        if (tag) { (caps[tag] = caps[tag] || []).push(args[0]); return; }
                        const now = Date.now();
                        if (!last[name] || now - last[name] > 1000) { last[name] = now; emit("msg:" + name, {}); }
                    },
                });
                cmdHooks++;
            } catch (e) { /* */ }
            if (cmdHooks >= 3000) break;
        }
        if (cmdHooks >= 3000) break;
    }
}
console.log("[rw] generic Cmd_* hooks=" + cmdHooks + " watch=" + Object.keys(WATCH).join(","));

// ---- method-level hooks (ctor-bypassed replies + the profile-open flow)
// reply SC objects are unpacked by GameServerConfig.Unpack(typeof(SC), ...) -> no .ctor.
function findMethodAny(klass, name) {
    if (!klass) return null;
    const iter = Memory.alloc(8);
    let m = classGetMethods(klass, iter);
    while (!m.isNull()) {
        try {
            if (cstr(methodGetName(m)) === name) return { info: m, code: m.readPointer(), argc: methodGetParamCount(m) };
        } catch (e) { /* */ }
        m = classGetMethods(klass, iter);
    }
    return null;
}
function hookNamed(klass, name, onHit) {
    const m = findMethodAny(klass, name);
    if (!m) { console.log("[rw] no method " + name); return; }
    console.log("[rw] hook " + name + "/" + m.argc + " @ " + m.code);
    Interceptor.attach(m.code, { onEnter(args) { try { onHit(args, m.argc); } catch (e) { /* */ } } });
}
const FMC = findKlass("Friends", "FriendManagerController");
hookNamed(FMC, "OnResponseBattleData", (args) => {   // (this, SC) -- the real battle-data reply
    const p = args[1];
    if (p.isNull() || p.toUInt32() < 0x1000) return;
    try { const o = dumpBattleSC(p); if (o && o.total > 0) emit("OnRespBattleData", o); } catch (e) { /* */ }
});
hookNamed(FMC, "RequestPlayerBaseInfoData", (args) => {  // (uid, svr, ?, ?, ?) = profile open
    emit("ReqPlayerBaseInfoData", { uid: args[1].toString(), svr: args[2].toUInt32() });
});
hookNamed(FMC, "RequestBattleData", (args) => {          // the UI's exact career-data args
    let s = "";
    try { s = istr(args[5]); } catch (e) { /* */ }
    emit("ReqBattleData", {
        uid: args[1].toString(), svr: args[2].toUInt32(), rankType: args[3].toUInt32(),
        rankHero: args[4].toUInt32(), str: s, bool: args[6].toUInt32(),
    });
});
hookNamed(FMC, "RequestBaseBattleData", (args) => {      // career tab on a profile
    emit("ReqBaseBattleData", { a1: args[1].toString(), a2: args[2].toString(), a3: args[3].toString() });
});
hookNamed(FMC, "OnReqOtherPlayerBaseInfo", () => emit("OnReqOtherPlayerBaseInfo", {}));
hookNamed(FMC, "OnRoleGetBaseInfo", () => emit("OnRoleGetBaseInfo", {}));

// ---- wire-level traffic (ctor-independent): all outgoing + incoming cmdIds
// base self-check via FindFriends CS ctor RVA 0x5d03efc (imagebase 0 -> RVA == file off)
let BASE = null;
try {
    const c = ctorAddr(K.FindCS);
    if (c) { const d = c.sub(0x5d03efc); if (d.and(ptr(0xfff)).isNull()) BASE = d; }
} catch (e) { /* */ }
console.log("[rw] base " + BASE);
if (BASE) {
    const lastWire = {};
    function wire(ev, id) {
        const k = ev + id, now = Date.now();
        const slow = (id === 10017 || id === 10005 || id === 10006);   // keepalive/ping - quiet them
        if (!lastWire[k] || now - lastWire[k] > (slow ? 15000 : 1000)) { lastWire[k] = now; emit(ev, { cmd: id }); }
    }
    Interceptor.attach(BASE.add(0x4ccab58), { onEnter(args) {          // GameServerConfig.SendData
        try { wire("out", args[1].toUInt32()); } catch (e) { /* */ }
    } });
    Interceptor.attach(BASE.add(0x2c70d90), { onEnter(args) {          // GameReceiveMessage.RealGameSocketOnRecv
        try { wire("in", args[1].readU32()); } catch (e) { /* */ }
    } });
    console.log("[rw] wire taps up");
}

function emit(ev, o) { console.log(JSON.stringify({ t: Date.now(), ev, o })); }

setInterval(() => {
    for (const tag of Object.keys(caps)) {
        const arr = caps[tag];
        while (arr.length) {
            const p = arr.shift();
            const key = tag + p.toString();
            if (seen.has(key)) continue;
            try {
                let o = null;
                if (tag === "BattleCS") { o = dumpBattleCS(p); if (o.uid === "0") continue; seen.add(key); }
                else if (tag === "FindCS") { o = dumpFindCS(p); if (o.uid === "0" && !o.sName) continue; seen.add(key); }
                else if (tag === "GetBaseCS") { o = dumpGetBaseCS(p); if (o.uid === "0") continue; seen.add(key); }
                else if (tag === "BattleSC") { o = dumpBattleSC(p); if (!o || o.total <= 0) continue; seen.add(key); }
                else if (tag === "FindSC") {
                    const rows = listPtrs(sptr(p, 0x10), 64).map(dumpFBI);
                    if (!rows.length) continue;
                    o = { friends: rows }; seen.add(key);
                }
                else if (tag === "FriendBaseInfo") {
                    o = dumpFBI(p);
                    if (o.uid === "0") continue;
                    // wait until the deserializer has actually filled something
                    if (!o.mostUse.length && !o.fav.length && !o.name) continue;
                    seen.add(key);
                }
                else if (tag === "PlayerBaseInfo") {
                    o = dumpPBI(p);
                    if (o.uid === "0" || (!o.name && !o.fav.length)) continue;
                    seen.add(key);
                }
                else if (tag === "LBSMMR") {
                    o = { heroMMR: dictHeroMMR(sptr(p, 0x10)) };
                    if (!o.heroMMR.length) continue;
                    seen.add(key);
                }
                else if (tag === "MMRComp") {
                    o = dumpMMRComp(p);
                    seen.add(key);
                }
                if (o) emit(tag, o);
            } catch (e) { /* */ }
        }
    }
}, 300);

console.log("[rw] watching - do UI now (profile / rankings / id search)");
