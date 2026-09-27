// room_dump.js â€” draft-phase room-info reader (the room-hack panel data source)
// Polls Friends.RoomDataManager._instance._players (Dict<ulong, MTTDProto.RoomPlayerInfo>)
// and writes the parsed roster to room.json on the device.
// The overlay reads this file instead of cppport's stdout while bm:0.
//
// usage: attach at the DRAFT screen (or before), it polls every 2s while the room lives.

const OUT = "/data/user/11/com.mobile.legends/cache/ilregs/room.json";
const lib = Process.getModuleByName("liblogic.so");
const libc = Process.getModuleByName("libc.so");
const fopen = new NativeFunction(libc.getExportByName("fopen"), "pointer", ["pointer", "pointer"]);
const fwrite = new NativeFunction(libc.getExportByName("fwrite"), "ulong", ["pointer", "ulong", "ulong", "pointer"]);
const fclose = new NativeFunction(libc.getExportByName("fclose"), "int", ["pointer"]);
const mkdir = new NativeFunction(libc.getExportByName("mkdir"), "int", ["pointer", "int"]);
const E = (name, ret, args) => new NativeFunction(lib.getExportByName(name), ret, args);
const domainGet = E("il2cpp_domain_get", "pointer", []);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const imageGetName = E("il2cpp_image_get_name", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const SF_OFF = 0xb8; // Il2CppClass.static_fields (2019.4)

const cstr = (p) => (p.isNull() ? "" : p.readUtf8String());
// Il2Cpp System.String = {klass, monitor, int32 length, utf16 chars[]}
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
    } catch (e) {
        return "";
    }
}
const jsonEscape = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\x00-\x1f]/g, "");

function findKlass() {
    const domain = domainGet();
    const sizeBuf = Memory.alloc(8);
    const assemblies = domainGetAssemblies(domain, sizeBuf);
    const count = sizeBuf.readU64().toNumber();
    const mkStr = (s) => Memory.allocUtf8String(s);
    for (let i = 0; i < count; i++) {
        const asm = assemblies.add(i * Process.pointerSize).readPointer();
        const img = assemblyGetImage(asm);
        if (img.isNull()) continue;
        const k = classFromName(img, mkStr("Friends"), mkStr("RoomDataManager"));
        if (!k.isNull()) return k;
    }
    return null;
}

function getInstance(klass) {
    if (!klass || klass.isNull()) return ptr(0);
    const sf = klass.add(SF_OFF).readPointer();
    if (sf.isNull()) return ptr(0);
    return sf.readPointer(); // RoomDataManager._instance @0x0
}

// Dictionary<ulong, RoomPlayerInfo> walk
function dictWalk(dict) {
    if (dict.isNull()) return [];
    const entries = dict.add(0x18).readPointer();
    const count = dict.add(0x20).readS32();
    if (count <= 0 || count > 16 || entries.isNull()) return [];
    const maxlen = entries.add(0x18).readU32();
    const n = Math.min(count, maxlen);
    if (n <= 0) return [];
    const buf = entries.add(0x20).readByteArray(n * 0x18);
    const out = [];
    for (let i = 0; i < n; i++) {
        const e = new DataView(buf, i * 0x18);
        const uid = e.getBigUint64(8, true);
        const val = e.getBigUint64(16, true);
        if (val >= 0x1000n) out.push({ uid: uid.toString(), rpi: ptr(val.toString()) });
    }
    return out;
}

function favTop(base, top) {
    // PlayerBaseInfo.mHeroMMR @0x88 = Dictionary<uint,uint>
    const dict = base.add(0x88).readPointer();
    if (dict < 0x1000) return [];
    const entries = dict.add(0x18).readPointer();
    const count = dict.add(0x20).readS32();
    if (count <= 0 || count > 256 || entries.isNull()) return [];
    const maxlen = entries.add(0x18).readU32();
    const n = Math.min(count, maxlen);
    if (n <= 0) return [];
    const buf = entries.add(0x20).readByteArray(n * 0x18);
    const pairs = [];
    for (let i = 0; i < n; i++) {
        const e = new DataView(buf, i * 0x18);
        const k = e.getUint32(8, true), v = e.getUint32(16, true);
        if (k) pairs.push([k, v]);
    }
    pairs.sort(function (a, b) { return b[1] - a[1]; });
    return pairs.slice(0, top);
}

function dumpRoom() {
    const klass = findKlass();
    if (!klass) { console.log("[!] RoomDataManager class not found"); return; }
    const inst = getInstance(klass);
    if (inst < 0x1000) { console.log("[*] no room instance (not in a room)"); return; }
    const players = inst.add(0x10).readPointer();
    if (players < 0x1000) { console.log("[*] room exists, no players"); return; }

    const rows = dictWalk(players);
    let json = "{\"ts\":" + Date.now() + ",\"players\":[";
    let first = true;
    for (const p of rows) {
        const rpi = p.rpi;
        if (!first) json += ",";
        first = false;
        json += "{\"uid\":\"" + p.uid + "\",";
        json += "\"svr\":" + rpi.add(0x18).readU32() + ",";
        json += "\"name\":\"" + jsonEscape(cstr(rpi.add(0x20).readPointer())) + "\",";
        json += "\"rank\":" + rpi.add(0x34).readU32() + ",";
        json += "\"rankBig\":" + rpi.add(0x38).readU32() + ",";
        json += "\"nation\":" + rpi.add(0x30).readU32() + ",";
        json += "\"camp\":" + rpi.add(0xa0).readU32() + ",";
        json += "\"road\":" + rpi.add(0xfc).readU32() + ",";
        json += "\"ready\":" + (rpi.add(0x91).readU8() ? "true" : "false") + ",";
        const base = rpi.add(0x48).readPointer();
        if (base >= 0x1000) {
            const favs = favTop(base, 3);
            json += "\"favs\":" + JSON.stringify(favs);
        } else {
            json += "\"favs\":[]";
        }
        json += "}";
    }
    json += "}";
    mkdir(Memory.allocUtf8String("/data/user/11/com.mobile.legends/cache/ilregs/"), 493);
    const fp = fopen(Memory.allocUtf8String(OUT), Memory.allocUtf8String("wb"));
    if (!fp.isNull()) {
        const p = Memory.allocUtf8String(json);
        // UTF-8 byte length (names can be multibyte)
        let n = 0;
        for (const ch of json) {
            const c = ch.codePointAt(0);
            n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        }
        fwrite(p, 1, n, fp);
        fclose(fp);
        console.log("[*] room.json updated (" + rows.length + " players)");
    }
}

setInterval(dumpRoom, 2000);
console.log("[*] room_dump.js polling every 2s â€” attach during draft");
