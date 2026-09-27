'use strict';

// meta_scan v2 - decrypted global-metadata scanner, Frida-17-clean
// (no *Sync APIs, no readInt legacy, pointer-method reads only)

var SAVE_DIR = null;
var found = 0;
var MAXDUMP = 3;

function resolveSaveDir() {
    if (SAVE_DIR) return SAVE_DIR;
    try {
        Java.perform(function () {});
        var ctx = Java.use("android.app.ActivityThread").currentApplication();
        SAVE_DIR = ctx.getCacheDir().getAbsolutePath() + "/";
    } catch (e) {
        SAVE_DIR = "/data/user/11/com.mobile.legends/cache/";
    }
    console.log("[*] save dir: " + SAVE_DIR);
    return SAVE_DIR;
}

function readI32(p) { return p.readS32(); }   // Frida 17: readInt legacy alias is gone

function validateHeader(p) {
    var ver = readI32(p.add(4));
    if (ver < 23 || ver > 27) return null;
    var maxSize = 0, plausible = 0;
    for (var i = 8; i + 8 <= 0x108; i += 8) {            // header section pairs
        var off = readI32(p.add(i));
        var cnt = readI32(p.add(i + 4));
        if (off < 0x108 || off > 200 * 1024 * 1024) continue;
        if (cnt < 0 || cnt > 5000000) continue;
        plausible++;
        var end = off + cnt * 8;                          // 8 = max element stride
        if (end > maxSize && end < 200 * 1024 * 1024) maxSize = end;
    }
    if (plausible < 20 || maxSize < 1024 * 1024) return null;
    return { version: ver, size: maxSize };
}

function scanRange(base, size) {
    return new Promise(function (resolve) {
        try {
            Memory.scan(base, size, "af 1b b1 fa", {
                onMatch: function (addr) {
                    if (found >= MAXDUMP) return;
                    try {
                        var v = validateHeader(addr);
                        if (!v) { console.log("[?] magic @ " + addr + " failed validation"); return; }
                        found++;
                        var f = new File(resolveSaveDir() + "metadata_dump_" + found + "_v" + v.version + ".bin", "wb");
                        f.write(addr.readByteArray(v.size)); f.close();
                        console.log("[META] v" + v.version + " size=" + v.size + " @ " + addr + " -> file " + found);
                    } catch (e) { console.log("[!] hit err: " + e); }
                },
                onComplete: function () { resolve(); }
            });
        } catch (e) { console.log("[!] scan err: " + e); resolve(); }
    });
}

async function scanAll() {
    var ranges = await Process.enumerateRanges('rw-');     // Frida 17: async only
    console.log("[*] scanning " + ranges.length + " rw- ranges");
    for (var i = 0; i < ranges.length; i++) {
        var r = ranges[i];
        if (r.size > 512 * 1024 * 1024) continue;          // skip monster ranges
        await scanRange(r.base, r.size);
    }
    console.log("[DONE] candidates: " + found);
}

setTimeout(function () { scanAll(); }, 4000);
setTimeout(function () { console.log("[STAT] candidates=" + found); }, 60000);
