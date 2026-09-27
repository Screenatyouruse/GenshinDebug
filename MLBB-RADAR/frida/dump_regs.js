// dump_regs.js — dump ALL blob registration arrays to the device.
// Attach at boot (manual race) or anytime: the static regs (blob1 in liblogic,
// blob3 in libcsharp .data.rel.ro) dump on attach with no race; runtime-built
// regs (blob2) dump from the register_moba hook.
// Files: /data/user/11/com.mobile.legends/cache/ilregs/reg_<blob>_<array>_<count>.bin

var OUTDIR = "/data/user/11/com.mobile.legends/cache/ilregs/";
var libc = Process.getModuleByName("libc.so");
var fopen = new NativeFunction(libc.getExportByName("fopen"), "pointer", ["pointer", "pointer"]);
var fwrite = new NativeFunction(libc.getExportByName("fwrite"), "ulong", ["pointer", "ulong", "ulong", "pointer"]);
var fclose = new NativeFunction(libc.getExportByName("fclose"), "int", ["pointer"]);
var mkdir = new NativeFunction(libc.getExportByName("mkdir"), "int", ["pointer", "int"]);

function saveFile(fullpath, buf) {
    var fp = fopen(Memory.allocUtf8String(fullpath), Memory.allocUtf8String("wb"));
    if (fp.isNull()) { console.log("[!] fopen failed: " + fullpath); return; }
    var data = (buf instanceof Uint8Array) ? buf.buffer : buf;
    var n = fwrite(data, 1, data.byteLength, fp);
    fclose(fp);
    console.log("[*] saved " + fullpath + " (" + n + " bytes)");
}

// MetadataRegistration (v24.4): count(u32)+pad(u32)+ptr(u64), 16B stride
var ARRAYS = [
    ["genericClasses", 0, 12],
    ["genericInsts", 16, 16],
    ["genericMethodTable", 32, 16],
    ["types", 48, 12],
    ["methodSpecs", 64, 12],
    ["fieldOffsets", 80, 4],
    ["typeDefinitionsSizes", 96, 4],
    ["metadataUsages", 112, 4]
];

function readableRange(addr, size) {
    var start = addr;
    var end = addr.add(size);
    while (start.compare(end) < 0) {
        var r = Process.findRangeByAddress(start);
        if (r === null) return false;
        start = r.base.add(r.size);
    }
    return true;
}

var RANGES = [];
function buildRangeMap() {
    RANGES = Process.enumerateRanges("r--").sort(function (a, b) { return a.base.compare(b.base); });
}
function nextReadable(addr) {
    // returns {start, end} of the readable range containing addr, or the next one after it, or null
    for (var i = 0; i < RANGES.length; i++) {
        var r = RANGES[i];
        var rend = r.base.add(r.size);
        if (rend.compare(addr) <= 0) continue;
        return { start: (r.base.compare(addr) > 0) ? r.base : addr, end: rend };
    }
    return null;
}

function dumpReg(metaReg, label) {
    buildRangeMap();
    mkdir(Memory.allocUtf8String(OUTDIR), 493);
    for (var i = 0; i < ARRAYS.length; i++) {
        var name = ARRAYS[i][0], off = ARRAYS[i][1], elsz = ARRAYS[i][2];
        try {
            var cnt = metaReg.add(off).readU32();
            var ptr = metaReg.add(off + 8).readPointer();
            console.log("    " + name + ": cnt=" + cnt + " ptr=" + ptr);
            if (cnt === 0 || ptr.isNull()) continue;
            if (cnt > 10000000) { console.log("[!] " + label + " " + name + ": bogus cnt " + cnt); continue; }
            var total = cnt * elsz;
            var fp = fopen(Memory.allocUtf8String(OUTDIR + "reg_" + label + "_" + name + "_" + cnt + ".bin"), Memory.allocUtf8String("wb"));
            if (fp.isNull()) { console.log("[!] fopen failed: " + label + " " + name); continue; }
            var got = 0;
            var p = 0;
            while (p < total) {
                var seg = nextReadable(ptr.add(p));
                if (seg === null) break;
                var avail = seg.end.sub(ptr.add(p)).toUInt32();
                var n = Math.min(262144, total - p, avail);
                if (n <= 0) break;
                var chunk = seg.start.readByteArray(n);
                fwrite(chunk, 1, chunk.byteLength, fp);
                got += n;
                p += n;
            }
            fclose(fp);
            console.log("[*] " + label + " " + name + ": wrote " + got + "/" + total + " bytes");
        } catch (e) {
            console.log("[!] " + label + " " + name + " skipped: " + e);
        }
    }
}

function main() {
    var wait = setInterval(function () {
        var lib = Process.findModuleByName("liblogic.so");
        if (!lib) return;
        clearInterval(wait);
        console.log("[*] liblogic @ " + lib.base);
        // blob1: static registration in liblogic
        var mreg1 = lib.base.add(0x19a0b40);
        var fo1 = mreg1.add(80).readU32();
        console.log("[*] blob1 static reg fieldOffsetsCount=" + fo1);
        if (fo1 === 5440) dumpReg(mreg1, "blob1_static");
        // blob3: static registration in libcsharp
        var cs = Process.findModuleByName("libcsharp.so");
        if (cs) {
            var mreg3 = cs.base.add(0x6f43fe0);
            var t3 = mreg3.add(48).readU32();
            console.log("[*] blob3 static reg typesCount=" + t3);
            if (t3 === 196346) dumpReg(mreg3, "blob3_static");
        }
        // hooks for runtime-built registrations (blob2 + any others)
        Interceptor.attach(lib.base.add(0xf8e5c4), function (args) {
            var bid = args[3].toInt32();
            var nm = args[5].readCString().replace(/[^a-z]/gi, "");
            console.log("=== register_moba blob" + bid + " \"" + nm + "\" ===");
            dumpReg(args[1], "blob" + bid + "_" + nm);
        });
        Interceptor.attach(lib.base.add(0xf8e5b0), function (args) {
            console.log("=== codegen_register ===");
            dumpReg(args[1], "blob1_hook");
        });
        console.log("[*] hooks installed");
    }, 300);
}
main();
