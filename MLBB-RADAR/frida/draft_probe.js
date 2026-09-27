// draft_probe.js — locate the REAL draft player data.
// Dumps BOTH:
//   Friends.RoomDataManager._instance._players  (custom/party room, Dict<ulong,RoomPlayerInfo>)
//   ChooseHeroMgr.Instance + its RoomData lists (m_SelfCampHeroInfoList / m_OpenBlack*)
// Attach at the custom draft lobby. Pure runtime reflection, nothing from disk.

const lib = Process.getModuleByName("liblogic.so");
const E = (name, ret, args) => new NativeFunction(lib.getExportByName(name), ret, args);
const domainGet = E("il2cpp_domain_get", "pointer", []);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const SF_OFF = 0xb8; // Il2CppClass.static_fields (2019.4)

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

// il2cpp System.String {klass,monitor,len@0x10,utf16@0x14}
function istr(p) {
    if (p.isNull() || p < 0x1000) return "";
    try {
        const len = p.add(0x10).readS32();
        if (len <= 0 || len > 128) return "";
        const b = p.add(0x14).readByteArray(len * 2);
        const dv = new DataView(b);
        let s = "";
        for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(i * 2, true));
        return s;
    } catch (e) { return ""; }
}
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\x00-\x1f]/g, "");

// List<T>: items @0x10, size @0x18 ; Il2CppArray: max_length @0x18, vector @0x20
function listPtrs(list) {
    if (list.isNull() || list < 0x1000) return [];
    try {
        const items = list.add(0x10).readPointer();
        const size = list.add(0x18).readS32();
        if (items.isNull() || size <= 0 || size > 64) return [];
        const n = Math.min(size, items.add(0x18).readU32());
        const dv = new DataView(items.add(0x20).readByteArray(n * 8));
        const out = [];
        for (let i = 0; i < n; i++) { const p = ptr(dv.getBigUint64(i * 8, true).toString()); if (p >= 0x1000) out.push(p); }
        return out;
    } catch (e) { return []; }
}
function listU32(list) {
    if (list.isNull() || list < 0x1000) return [];
    try {
        const items = list.add(0x10).readPointer();
        const size = list.add(0x18).readS32();
        if (items.isNull() || size <= 0 || size > 64) return [];
        const n = Math.min(size, items.add(0x18).readU32());
        const dv = new DataView(items.add(0x20).readByteArray(n * 4));
        const out = [];
        for (let i = 0; i < n; i++) out.push(dv.getUint32(i * 4, true));
        return out;
    } catch (e) { return []; }
}
// Dictionary<K,V> entries: entries@0x18, count@0x20; Entry{hash@0,next@4,key@8,val@0x10} stride 0x18
function dictEntries(dict) {
    if (dict.isNull() || dict < 0x1000) return [];
    try {
        const entries = dict.add(0x18).readPointer();
        const count = dict.add(0x20).readS32();
        if (entries.isNull() || count <= 0 || count > 64) return [];
        const n = Math.min(count, entries.add(0x18).readU32());
        const buf = entries.add(0x20).readByteArray(n * 0x18);
        const dv = new DataView(buf);
        const out = [];
        for (let i = 0; i < n; i++) {
            const key = dv.getBigUint64(i * 0x18 + 8, true);
            const val = ptr(dv.getBigUint64(i * 0x18 + 16, true).toString());
            out.push({ key: key.toString(), val });
        }
        return out;
    } catch (e) { return []; }
}

// ---- RoomDataManager (custom/party room) ----
function dumpRoom() {
    const k = findKlass("Friends", "RoomDataManager");
    if (!k) return { err: "RoomDataManager not found" };
    const sf = k.add(SF_OFF).readPointer();
    const inst = sf.isNull() ? ptr(0) : sf.readPointer(); // _instance @ static 0x0
    const res = { inst: inst.toString(), players: [] };
    if (inst < 0x1000) return res;
    const dict = inst.add(0x10).readPointer();
    for (const e of dictEntries(dict)) {
        const p = e.val;
        res.players.push({
            uid: e.key,
            svr: p.add(0x18).readU32(),
            name: esc(istr(p.add(0x20).readPointer())),
            rank: p.add(0x34).readU32(),
            rankBig: p.add(0x38).readU32(),
            nation: p.add(0x30).readU32(),
            country: esc(istr(p.add(0x78).readPointer())),
            online: p.add(0x90).readU8(),
            ready: p.add(0x91).readU8(),
            camp: p.add(0xa0).readU32(),
            road: p.add(0xfc).readU32(),
            want: listU32(p.add(0x130).readPointer()),
        });
    }
    return res;
}

// ---- ChooseHeroMgr (draft camps) ----
function roomData(p, tag) {
    try {
        return {
            _src: tag,
            uid: p.add(0x20).readU64().toString(),
            camp: p.add(0x30).readU32(),
            pos: p.add(0x34).readU32(),
            name: esc(istr(p.add(0x40).readPointer())),
            robot: p.add(0x48).readU8(),
            heroid: p.add(0x4c).readU32(),
            skin: p.add(0x50).readU32(),
            country: p.add(0x5c).readU32(),
            rank: p.add(0x128).readU32(),
            road: p.add(0x140).readU32(),
            actCamp: p.add(0x15c).readU32(),
            banHero: p.add(0xb0).readU32(),
            want: listU32(p.add(0x228).readPointer()),
            choose: p.add(0x200).readU32(),
        };
    } catch (e) { return { _src: tag, err: String(e) }; }
}
const LISTS = [
    ["m_SelfCampHeroInfoList", 0x358],
    ["m_OpenBlackPlayList0", 0x360],
    ["m_OpenBlackPlayList1", 0x368],
    ["m_SelfCampCommonPlayList", 0x370],
    ["m_OpenBlackList", 0x378],
];
function dumpChoose() {
    const k = findKlass("", "ChooseHeroMgr");
    if (!k) return { err: "ChooseHeroMgr not found" };
    const sf = k.add(SF_OFF).readPointer();
    const inst = sf.isNull() ? ptr(0) : sf.readPointer();
    const res = { inst: inst.toString(), lists: {} };
    if (inst >= 0x1000) for (const [name, off] of LISTS) {
        res.lists[name] = listPtrs(inst.add(off).readPointer()).map((q) => roomData(q, name));
    }
    return res;
}

function dump() {
    console.log(JSON.stringify({ t: Date.now(), room: dumpRoom(), choose: dumpChoose() }));
}
setInterval(dump, 1500);
dump();
console.log("[*] draft_probe running — attach at the custom draft lobby");
