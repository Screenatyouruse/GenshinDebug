// stalk.js — one-shot MLBB profile stalker (updated post-patch via invoke_battledata.js).
//
// Calls the game's OWN request functions and hooks the replies:
//   1) FriendManagerController.SearchFriend(uid)
//      -> Cmd_Friend_FindFriends_SC -> FriendBaseInfo.vMostUseHeroIds@0x1a8
//         (the 3 profile portraits) + career win/games
//   2) FriendManagerController.RequestBattleData(uid, svr, ...)
//      -> Cmd_Battle_GetBattleData_SC (career winrate / MVP / popularity / mode breakdown / top heroes)
//
// Build fingerprint: dump_raw.cs post-patch (2026-09).
// All methods resolved by NAME at runtime (no stale hardcoded RVAs).
//
// manual run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l stalk.js --runtime qjs -q
// or by PID:
//   frida -H 127.0.0.1:27043 -p <pid> -l stalk.js --runtime qjs -q

const PARAMS = { uid: "700843674", svr: 10308, timeoutMs: 30000, rankTypes: [0], sMd5Null: true, softFinishMs: 9000, passive: false }; // {{PARAMS}}

const TARGET_UID = String(PARAMS.uid);
const TARGET_SVR = Number(PARAMS.svr);

const lib = Process.getModuleByName("liblogic.so");
const E = (n, r, a) => new NativeFunction(lib.getExportByName(n), r, a);
const domainGet = E("il2cpp_domain_get", "pointer", []);
const threadAttach = E("il2cpp_thread_attach", "pointer", ["pointer"]);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const classGetMethods = E("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"]);
const methodGetName = E("il2cpp_method_get_name", "pointer", ["pointer"]);
const methodGetParamCount = E("il2cpp_method_get_param_count", "uint32", ["pointer"]);
const methodGetParamName = E("il2cpp_method_get_param_name", "pointer", ["pointer", "uint32"]);
const methodGetParam = E("il2cpp_method_get_param", "pointer", ["pointer", "uint32"]);
const typeGetName = E("il2cpp_type_get_name", "pointer", ["pointer"]);
const classGetMethodFromName = E("il2cpp_class_get_method_from_name", "pointer", ["pointer", "pointer", "int"]);
const runtimeInvoke = E("il2cpp_runtime_invoke", "pointer", ["pointer", "pointer", "pointer", "pointer"]);
const fieldFromName = E("il2cpp_class_get_field_from_name", "pointer", ["pointer", "pointer"]);
const fieldStaticGetValue = E("il2cpp_field_static_get_value", "void", ["pointer", "pointer"]);
const strNew = E("il2cpp_string_new", "pointer", ["pointer"]);

function cstr(p) { return p.isNull() ? "" : p.readUtf8String(); }
function log(msg) { console.log("[stalk] " + msg); }

// heroId -> name (1..128 verified; 129+ = Zetian, Obsidia, Sora, Marcel, Hirara)
const HERO_NAMES = ("Miya,Balmond,Saber,Alice,Nana,Tigreal,Alucard,Karina,Akai,Franco,Bane,Bruno,Clint,Rafaela," +
    "Eudora,Zilong,Fanny,Layla,Minotaur,Lolita,Hayabusa,Freya,Gord,Natalia,Kagura,Chou,Sun,Alpha,Ruby,Yi Sun-shin," +
    "Moskov,Johnson,Cyclops,Estes,Hilda,Aurora,Lapu-Lapu,Vexana,Roger,Karrie,Grock,Harley,Irithel,Grock,Argus,Odette," +
    "Lancelot,Diggie,Hylos,Zhask,Helcurt,Pharsa,Lesley,Jawhead,Angela,Gusion,Valir,Martis,Uranus,Hanabi,Chang'e,Kaja," +
    "Selena,Aldous,Claude,Vale,Leomord,Lunox,Hanzo,Belerick,Kimmy,Thamuz,Harith,Minsitthar,Kadita,Faramis,Badang,Khufra," +
    "Granger,Guinevere,Esmeralda,Terizla,X.Borg,Ling,Dyrroth,Lylia,Baxia,Masha,Wanwan,Silvanna,Carmilla,Cecilion,Atlas," +
    "Popol and Kupa,Yu Zhong,Luo Yi,Benedetta,Khaleed,Barats,Brody,Yve,Mathilda,Paquito,Gloo,Beatrix,Phoveus,Natan,Aulus," +
    "Aamon,Valentina,Edith,Floryn,Yin,Melissa,Xavier,Julian,Fredrinn,Joy,Novaria,Arlott,Ixia,Nolan,Cici,Chip,Zhuxin,Suyou," +
    "Lukas,Kalea,Zetian,Obsidia,Sora,Marcel,Hirara").split(",");
function heroName(id) { const n = HERO_NAMES[id - 1]; return n || ("#" + id); }
function topLine(o) {
    const hs = (o && o.heros) || [];
    if (!hs.length) return "top: (no heroes in payload)";
    const top = hs.slice().sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 12);
    return "top: " + top.map((h) => (h.total ? heroName(h.hero) + " " + h.total + " (" + Math.round(100 * (h.win || 0) / h.total) + "%)" : heroName(h.hero))).join(", ");
}

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

function methodByName(klass, name, targetArgc) {
    if (!klass) return null;
    const it = Memory.alloc(8);
    for (let m = classGetMethods(klass, it); !m.isNull(); m = classGetMethods(klass, it)) {
        try {
            if (cstr(methodGetName(m)) === name) {
                if (targetArgc === undefined || methodGetParamCount(m) === targetArgc) {
                    return m;
                }
            }
        } catch (e) { }
    }
    return null;
}

function istr(p) {  // il2cpp System.String: len@0x10, utf16@0x14
    if (p.isNull() || p.toUInt32() < 0x1000) return "";
    try {
        const len = p.add(0x10).readS32();
        if (len <= 0 || len > 96) return "";
        const b = p.add(0x14).readByteArray(len * 2); const dv = new DataView(b); let s = "";
        for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(i * 2, true));
        return s;
    } catch (e) { return ""; }
}

function listU32(list, cap) {
    const out = [];
    if (list.isNull() || list.toUInt32() < 0x1000) return out;
    try {
        const items = list.add(0x10).readPointer(); const size = list.add(0x18).readS32();
        if (items.isNull() || size <= 0 || size > (cap || 512)) return out;
        const nn = Math.min(size, items.add(0x18).readU32());
        const dv = new DataView(items.add(0x20).readByteArray(nn * 4));
        for (let i = 0; i < nn; i++) out.push(dv.getUint32(i * 4, true));
    } catch (e) { }
    return out;
}

function listPtrs(list, cap) {
    const out = [];
    if (list.isNull() || list.toUInt32() < 0x1000) return out;
    try {
        const items = list.add(0x10).readPointer(); const size = list.add(0x18).readS32();
        if (items.isNull() || size <= 0 || size > (cap || 512)) return out;
        const nn = Math.min(size, items.add(0x18).readU32());
        const dv = new DataView(items.add(0x20).readByteArray(nn * 8));
        for (let i = 0; i < nn; i++) {
            const q = ptr(dv.getBigUint64(i * 8, true).toString());
            if (!q.isNull()) out.push(q);
        }
    } catch (e) { }
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
        for (let i = 0; i < nn; i++) {
            const k = dv.getUint32(i * 0x10 + 8, true);
            const v = dv.getUint32(i * 0x10 + 12, true);
            if (k) out.push([k, v]);
        }
        out.sort((a, b) => b[1] - a[1]);
    } catch (e) { }
    return out.slice(0, top || 8);
}

function u32(p, o, d) { try { return p.add(o).readU32(); } catch (e) { return d; } }
function u64(p, o, d) { try { return p.add(o).readU64().toString(); } catch (e) { return d; } }
function sptr(p, o) { try { return p.add(o).readPointer(); } catch (e) { return ptr(0); } }

// ---------------------------------------------------------------- dumps
function dumpFbi(p) {
    return {
        uid: u64(p, 0x10, "?"), svr: u32(p, 0x18, 0),
        name: istr(sptr(p, 0x20)),
        rank: u32(p, 0x3c, 0), win: u32(p, 0x70, 0), games: u32(p, 0x74, 0),
        fav: dictU32Top(sptr(p, 0x78), 5),
        mostUse: listU32(sptr(p, 0x1a8), 512),
    };
}

// Synced with invoke_battledata.js (post-2026-09 patch layout)
function dumpBattleSC(p) {
    const base = sptr(p, 0x68);
    const heros = listPtrs(sptr(p, 0x98), 256)
        .map((h) => ({ hero: u32(h, 0x10, 0), total: u32(h, 0x14, 0), win: u32(h, 0x18, 0) }))
        .sort((a, b) => b.total - a.total).slice(0, 10);
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
                if (!vp.isNull()) byType.push({ type: k, total: u32(vp, 0x10, 0), win: u32(vp, 0x14, 0), rankTotal: u32(vp, 0x58, 0) });
            }
        }
    } catch (e) { }

    return {
        // 2026-09 patch updates:
        // ulUid@0x58; popularity 0xd8->0xe8; rankType 0xb8->0xc8; rankHero 0xbc->0xcc; useCount 0xe0->0xf0
        uid: u64(p, 0x58, "?"),
        total: u32(p, 0x10, 0), win: u32(p, 0x14, 0), mvp: u32(p, 0x24, 0), kda: u32(p, 0x3c, 0),
        week: u32(p, 0x18, 0), weekMax: u32(p, 0x1c, 0),
        popularity: u32(p, 0xe8, 0),
        rankType: u32(p, 0xc8, 0), rankHero: u32(p, 0xcc, 0),
        byType,
        base: (base.isNull() || base.toUInt32() < 0x1000) ? null : {
            uid: u64(base, 0x10, "?"), svr: u32(base, 0x18, 0), name: istr(sptr(base, 0x20)),
            rank: u32(base, 0x34, 0), win: u32(base, 0x80, 0), games: u32(base, 0x84, 0),
            fav: dictU32Top(sptr(base, 0x88), 5),
        },
        useCount: dictU32Top(sptr(p, 0xf0), 8),
        lastBuy: listU32(sptr(p, 0x78), 64),
        heros,
    };
}

// ---------------------------------------------------------------- state & hooks
const state = {
    battle: null,
    find: null,
    fbi: null,
    done: false,
};
const seen = { battle: new Set(), find: new Set(), fbi: new Set() };

threadAttach(domainGet());

const K = {
    BattleSC: findKlass("MTTDProto", "Cmd_Battle_GetBattleData_SC"),
    FindSC: findKlass("MTTDProto", "Cmd_Friend_FindFriends_SC"),
    FBI: findKlass("MTTDProto", "FriendBaseInfo"),
    FMC: findKlass("Friends", "FriendManagerController"),
};
log("[klass] " + Object.keys(K).map((n) => n + "=" + (K[n] ? "ok" : "NULL")).join(" "));

function onBattlePayload(p) {
    if (p.isNull() || p.toUInt32() < 0x1000) return;
    const key = p.toString();
    if (seen.battle.has(key)) return;
    seen.battle.add(key);

    setTimeout(() => {
        try {
            const o = dumpBattleSC(p);
            log("[wire] BattleSC reply total=" + (o.total || 0) + " uid=" + ((o.base && o.base.uid) || o.uid || "?"));
            if (!o || o.total <= 0) return;
            if (TARGET_UID !== "0" && o.base && o.base.uid !== TARGET_UID && o.uid !== TARGET_UID && o.base.uid !== "0") return;
            if (!state.battle) {
                state.battle = o;
                log("[+] BattleSC captured");
                console.log(JSON.stringify({ ev: "BATTLE", o: o }));
                log(topLine(o));
            }
        } catch (e) { }
    }, 30);
}

function onFindPayload(p) {
    if (p.isNull() || p.toUInt32() < 0x1000) return;
    const key = p.toString();
    if (seen.find.has(key)) return;
    seen.find.add(key);

    setTimeout(() => {
        try {
            const rows = listPtrs(sptr(p, 0x10), 64).map(dumpFbi);
            for (const r of rows) {
                if (TARGET_UID !== "0" && r.uid !== TARGET_UID) continue;
                if (!state.find) {
                    state.find = r;
                    log("[+] FindFriendsSC captured: " + r.name + " (" + r.uid + ")");
                    console.log(JSON.stringify({ ev: "FIND", o: r }));
                }
            }
        } catch (e) { }
    }, 30);
}

// 1. Hook BattleSC: via .ctor and OnResponseBattleData
if (K.BattleSC) {
    const ctor = methodByName(K.BattleSC, ".ctor", 0);
    if (ctor) {
        log("[hook] BattleSC .ctor @" + ctor.readPointer());
        Interceptor.attach(ctor.readPointer(), {
            onEnter(args) { onBattlePayload(args[0]); }
        });
    }
}
if (K.FMC) {
    const onResp = methodByName(K.FMC, "OnResponseBattleData", 1);
    if (onResp) {
        log("[hook] FMC.OnResponseBattleData @" + onResp.readPointer());
        Interceptor.attach(onResp.readPointer(), {
            onEnter(args) { onBattlePayload(args[1]); }
        });
    }
}

// 2. Hook FindFriends: via .ctor and OnFindFriend
if (K.FindSC) {
    const ctor = methodByName(K.FindSC, ".ctor", 0);
    if (ctor) {
        log("[hook] FindSC .ctor @" + ctor.readPointer());
        Interceptor.attach(ctor.readPointer(), {
            onEnter(args) { onFindPayload(args[0]); }
        });
    }
}
if (K.FMC) {
    const onFind = methodByName(K.FMC, "OnFindFriend", 1);
    if (onFind) {
        log("[hook] FMC.OnFindFriend @" + onFind.readPointer());
        Interceptor.attach(onFind.readPointer(), {
            onEnter(args) { onFindPayload(args[1]); }
        });
    }
}

// 3. Hook FriendBaseInfo .ctor
if (K.FBI) {
    const fbiCtor = methodByName(K.FBI, ".ctor", 0);
    if (fbiCtor) {
        Interceptor.attach(fbiCtor.readPointer(), {
            onEnter(args) {
                const p = args[0];
                setTimeout(() => {
                    try {
                        const r = dumpFbi(p);
                        if (!r || r.uid === "0" || (TARGET_UID !== "0" && r.uid !== TARGET_UID)) return;
                        if (r.mostUse.length && (!state.fbi || !state.fbi.mostUse.length)) {
                            state.fbi = r;
                            log("[+] FriendBaseInfo captured: " + r.name);
                            console.log(JSON.stringify({ ev: "FIND", o: r }));
                        }
                    } catch (e) { }
                }, 30);
            }
        });
    }
}

// ---------------------------------------------------------------- invocation
let instance = null;
if (K.FMC) {
    const f = fieldFromName(K.FMC, Memory.allocUtf8String("_instance"));
    const slot = Memory.alloc(8);
    if (!f.isNull()) { fieldStaticGetValue(f, slot); instance = slot.readPointer(); }
}
log("[*] FriendManagerController._instance = " + instance);

if (instance && !instance.isNull() && !PARAMS.passive) {
    // --- Step 1: UID Search (finds the 3 profile heroes & name)
    // Try SearchFriend(UInt64) or SearchFriendByUIDLua(UInt64)
    let searchMethod = null;
    let isStrSearch = false;

    const it = Memory.alloc(8);
    for (let m = classGetMethods(K.FMC, it); !m.isNull(); m = classGetMethods(K.FMC, it)) {
        const mName = cstr(methodGetName(m));
        if ((mName === "SearchFriend" || mName === "SearchFriendByUIDLua") && methodGetParamCount(m) === 1) {
            const param = methodGetParam(m, 0);
            const tName = cstr(typeGetName(param));
            if (tName.includes("UInt64")) {
                searchMethod = m;
                isStrSearch = false;
                break;
            } else if (tName.includes("String") && !searchMethod) {
                searchMethod = m;
                isStrSearch = true;
            }
        }
    }

    if (searchMethod) {
        const searchArgs = Memory.alloc(8);
        const slot = Memory.alloc(8);
        if (isStrSearch) {
            slot.writePointer(strNew(Memory.allocUtf8String(TARGET_UID)));
        } else {
            slot.writeU64(uint64(TARGET_UID));
        }
        searchArgs.writePointer(slot);
        const exc = Memory.alloc(8); exc.writePointer(ptr(0));
        runtimeInvoke(searchMethod, instance, searchArgs, exc);
        log("[*] " + cstr(methodGetName(searchMethod)) + "(" + TARGET_UID + ") sent");
    } else {
        log("[!] No SearchFriend method found on FMC");
    }

    // --- Step 2: RequestBattleData (career winrate / stats)
    if (TARGET_SVR > 0) {
        let method = methodByName(K.FMC, "RequestBattleData");
        if (!method || method.isNull()) {
            for (const a of [7, 6, 8, 5]) {
                method = classGetMethodFromName(K.FMC, Memory.allocUtf8String("RequestBattleData"), a);
                if (method && !method.isNull()) break;
            }
        }

        if (method && !method.isNull()) {
            const argc = methodGetParamCount(method);
            const names = [];
            for (let i = 0; i < argc; i++) {
                let n = "";
                try { n = methodGetParamName(method, i).readUtf8String(); } catch (e) { }
                names.push(n || ("arg" + i));
            }
            log("[*] RequestBattleData argc=" + argc + " params: " + names.map((n, i) => i + ":" + n).join(", "));

            const pUid = Memory.alloc(8); pUid.writeU64(uint64(TARGET_UID));
            const pSvr = Memory.alloc(4); pSvr.writeU32(TARGET_SVR);
            const pRankType = Memory.alloc(4);
            const pRankHero = Memory.alloc(4); pRankHero.writeU32(0);
            const pStr = Memory.alloc(8); pStr.writePointer(ptr(0));
            const pBool = Memory.alloc(8); pBool.writeU8(0);
            const pWall = Memory.alloc(4); pWall.writeU32(0); // 2026-09 bCollectionWall

            const known = [pUid, pSvr, pRankType, pRankHero, pStr, pBool, pWall];
            const scratch = [];
            const args = Memory.alloc(8 * Math.max(argc, 1));

            for (let i = 0; i < argc; i++) {
                const n = names[i].toLowerCase();
                let p = null;
                if (n.includes("uid")) p = pUid;
                else if (n.includes("svr") || n.includes("server")) p = pSvr;
                else if (n.includes("ranktype")) p = pRankType;
                else if (n.includes("rankhero")) p = pRankHero;
                else if (n.includes("md5") || n.includes("str")) p = pStr;
                else if (n.includes("cache")) p = pBool;
                else if (n.includes("collection") || n.includes("wall")) p = pWall;

                if (!p) p = known[i] || null;
                if (!p) {
                    p = Memory.alloc(8);
                    p.writeByteArray(new Array(8).fill(0));
                    scratch.push(p);
                }
                args.add(i * 8).writePointer(p);
            }

            const RANK_SEQ = PARAMS.rankTypes || [0, 1, 6];
            const sendBattle = (rt) => {
                pRankType.writeU32(rt);
                const exc = Memory.alloc(8); exc.writePointer(ptr(0));
                runtimeInvoke(method, instance, args, exc);
                const e = exc.readPointer();
                if (!e.isNull()) {
                    log("[!] RequestBattleData exc: " + (() => { try { return istr(e.add(0x20).readPointer()); } catch (x) { return "?"; } })());
                } else {
                    log("[*] RequestBattleData(uid=" + TARGET_UID + ", svr=" + TARGET_SVR + ", rankType=" + rt + ") sent");
                }
            };

            // Send first query, retry ladder if no response
            setTimeout(() => sendBattle(RANK_SEQ[0]), 500);
            let ri = 1;
            const ladder = setInterval(() => {
                if (state.battle || state.done || ri >= RANK_SEQ.length) {
                    clearInterval(ladder);
                    return;
                }
                sendBattle(RANK_SEQ[ri++]);
            }, 3000);
        } else {
            log("[!] RequestBattleData method not found on FMC");
        }
    }
} else if (PARAMS.passive) {
    log("[*] Passive mode active (listening only, no active sends)");
} else {
    log("[!] FMC._instance is null. Is the game at the lobby?");
}

// ---------------------------------------------------------------- termination
function finish(partial) {
    if (state.done) return;
    state.done = true;
    if (state.battle) log(topLine(state.battle));
    console.log(JSON.stringify({
        ev: "STALK_RESULT",
        ok: !!(state.battle || state.find || state.fbi),
        partial: !!partial,
        target: { uid: TARGET_UID, svr: TARGET_SVR },
        battle: state.battle,
        find: state.find || state.fbi,
    }));
    log("[*] Finished");
}

const checkDone = setInterval(() => {
    if (!state.done && state.battle && (state.find || state.fbi)) {
        clearInterval(checkDone);
        finish(false);
    }
}, 300);

setTimeout(() => {
    clearInterval(checkDone);
    finish(true);
}, PARAMS.timeoutMs || 20000);

log("[*] Armed — listening for responses...");
