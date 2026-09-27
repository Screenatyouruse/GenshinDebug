// dump_types_final.js — dump ALL registration arrays directly to the device.
// Static regs (blob1 in liblogic @0x19A0B40, blob3 in libcsharp @0x6f43fe0) dump on attach.
// Runtime regs (blob2) dump from the register_moba hook (boot race).
// Out: /data/user/11/com.mobile.legends/cache/ilregs/reg_<label>_<array>_<cnt>.bin

var OUTDIR = "/data/user/11/com.mobile.legends/cache/ilregs/";
var libc = Process.getModuleByName("libc.so");
var fopen = new NativeFunction(libc.getExportByName("fopen"), "pointer", ["pointer", "pointer"]);
var fwrite = new NativeFunction(libc.getExportByName("fwrite"), "ulong", ["pointer", "ulong", "ulong", "pointer"]);
var fclose = new NativeFunction(libc.getExportByName("fclose"), "int", ["pointer"]);
var mkdir = new NativeFunction(libc.getExportByName("mkdir"), "int", ["pointer", "int"]);

var ARRAYS = [
    ["genericClasses", 0, 12],
    ["genericInsts", 16, 16],
    ["genericMethodTable", 32, 16],
    ["types", 48, 12],
    ["methodSpecs", 64, 12],
    ["fieldOffsets", 80, 4],
    ["typeDefinitionsSizes", 96, 4]
];

var RANGES = [];
function buildRangeMap() {
    RANGES = Process.enumerateRanges("r--").sort(function (a, b) { return a.base.compare(b.base); });
}
function nextReadable(addr) {
    for (var i = 0; i < RANGES.length; i++) {
        var rend = RANGES[i].base.add(RANGES[i].size);
        if (rend.compare(addr) <= 0) continue;
        var st = (RANGES[i].base.compare(addr) > 0) ? RANGES[i].base : addr;
        return { start: st, end: rend };
    }
    return null;
}

function dumpArray(ptr, total, fullpath) {
    var fp = fopen(Memory.allocUtf8String(fullpath), Memory.allocUtf8String("wb"));
    if (fp.isNull()) { console.log("[!] fopen failed: " + fullpath); return -1; }
    var got = 0, p = 0;
    while (p < total) {
        var seg = nextReadable(ptr.add(p));
        if (seg === null) break;
        var avail = seg.end.sub(ptr.add(p)).toUInt32();
        var n = Math.min(1048576, total - p, avail);
        if (n <= 0) break;
        var r = fwrite(seg.start, 1, n, fp);
        if (r === 0) break;
        got += r;
        p += r;
    }
    fclose(fp);
    return got;
}

function dumpReg(metaReg, label) {
    buildRangeMap();
    mkdir(Memory.allocUtf8String(OUTDIR), 493);
    for (var i = 0; i < ARRAYS.length; i++) {
        var name = ARRAYS[i][0], off = ARRAYS[i][1], elsz = ARRAYS[i][2];
        try {
            var cnt = metaReg.add(off).readU32();
            var ptr = metaReg.add(off + 8).readPointer();
            if (cnt === 0 || ptr.isNull() || cnt > 10000000) continue;
            var total = cnt * elsz;
            var got = dumpArray(ptr, total, OUTDIR + "reg_" + label + "_" + name + "_" + cnt + ".bin");
            console.log("[*] " + label + " " + name + ": " + got + "/" + total);
        } catch (e) {
            console.log("[!] " + label + " " + name + ": " + e);
        }
    }
}

function main() {
    mkdir(Memory.allocUtf8String(OUTDIR), 493);
    var t0 = Date.now();
    var wait = setInterval(function () {
        var lib = Process.findModuleByName("liblogic.so");
        var cs = Process.findModuleByName("libcsharp.so");
        if (!lib || !cs) {
            if (Date.now() - t0 > 60000) { clearInterval(wait); console.log("[!] timeout waiting for libs"); }
            return;
        }
        clearInterval(wait);
        console.log("[*] liblogic @ " + lib.base);
        console.log("[*] libcsharp @ " + cs.base);
        var mreg1 = lib.base.add(0x19a0b40);
        var fo1 = mreg1.add(80).readU32();
        if (fo1 === 5440) {
            console.log("[*] blob1 static reg ok (fieldOffsetsCount=5440)");
            dumpReg(mreg1, "blob1_static");
        } else {
            console.log("[!] blob1 static reg mismatch: " + fo1);
        }
        var mreg3 = cs.base.add(0x6f43fe0);
        var t3 = mreg3.add(48).readU32();
        if (t3 === 196346) {
            console.log("[*] blob3 static reg ok");
            dumpReg(mreg3, "blob3_static");
        } else {
            console.log("[!] blob3 static mismatch: " + t3);
        }
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
        console.log("[*] hooks installed — waiting for register_moba calls");
    }, 300);
}
main();
