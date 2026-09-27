// resolve_room_slot.js — finds the static-field slot offset for Friends.RoomDataManager
// 1. resolve the class handle via il2cpp_class_from_name (runtime reflection)
// 2. scan libcsharp's writable memory for 8-byte tagged pointers to it (low 6 bytes match)
//    -> the addresses where the codegen stores that class pointer = the slots
// prints: slot.RoomDataManager = 0x...
const lib = Process.getModuleByName("liblogic.so");
const cs = Process.getModuleByName("libcsharp.so");
console.log("[*] liblogic @ " + lib.base + "  libcsharp @ " + cs.base);

const E = (name, ret, args) => new NativeFunction(lib.getExportByName(name), ret, args);
const domainGet = E("il2cpp_domain_get", "pointer", []);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const imageGetName = E("il2cpp_image_get_name", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);

const mkStr = (s) => Memory.allocUtf8String(s);

let klass = ptr(0), imgName = "";
const domain = domainGet();
const sizeBuf = Memory.alloc(8);
const assemblies = domainGetAssemblies(domain, sizeBuf);
const count = sizeBuf.readU64().toNumber();
for (let i = 0; i < count && klass.isNull(); i++) {
    const asm = assemblies.add(i * Process.pointerSize).readPointer();
    const img = assemblyGetImage(asm);
    const name = img.isNull() ? "?" : imageGetName(img).readUtf8String();
    const k = classFromName(img, mkStr("Friends"), mkStr("RoomDataManager"));
    if (!k.isNull()) { klass = k; imgName = name; }
}
if (klass.isNull()) {
    console.log("[!] RoomDataManager class not found");
} else {
    console.log("[*] klass = " + klass + " (in " + imgName + ")");

    // tagged pointer: 0xb40000XXXXXXXXXX — low 6 bytes identify the object,
    // top 2 bytes carry the GC tag, so pattern = 6 exact bytes + 2 wildcards
    const m = klass.and(0x0000FFFFFFFFFFFF);
    const hex = m.toString(16).padStart(12, "0");
    let pattern = "";
    for (let i = 5; i >= 0; i--) pattern += hex.substr(i * 2, 2) + " ";
    pattern += "?? ??";
    console.log("[*] scan pattern: " + pattern);

    const hits = [];
    const regions = [];
    for (const m of [cs, lib]) {
        for (const range of Process.enumerateRanges("rw-")) {
            if (range.base.compare(m.base) < 0 || range.base.compare(m.base.add(m.size)) >= 0) continue;
            regions.push(m, range);
        }
    }
    for (let i = 0; i < regions.length; i += 2) {
        const mod = regions[i], range = regions[i + 1];
        try {
            const matches = Memory.scanSync(range.base, range.size, pattern);
            for (const m2 of matches) {
                hits.push(m2.address);
                console.log("[*] candidate: " + mod.name + "+0x" + m2.address.sub(mod.base).toString(16));
            }
        } catch (e) {}
    }
    if (hits.length === 0) {
        console.log("[!] no slots found in libcsharp/liblogic rw ranges");
    } else {
        console.log("[*] slot.RoomDataManager = 0x" + hits[0].sub(cs.base).toString(16) + " (libcsharp)");
    }
}
