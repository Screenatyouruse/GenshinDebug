'use strict';

// meta_full v1 - full-size decrypted metadata dumper
// Parses Moonton repacked header live: [magic, ver=1024, idx, 252, then
// (offset,size) pairs; chain ends when size==0 or offset==0]. Dumps each
// blob from its start address through the computed chain end.

var SAVE_DIR = null;
var dumped = {};
var MAXBLOBS = 3;

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

function parseChain(addr) {
    var ver = addr.add(4).readS32();
    var idx = addr.add(8).readS32();
    var maxEnd = 0;
    for (var i = 4; i + 8 <= 0x108; i += 8) {
        var off = addr.add(i).readS32();
        var size = addr.add(i + 4).readS32();
        if (off <= 0 || size <= 0) break;                 // chain terminator
        if (off > 200 * 1024 * 1024 || size > 200 * 1024 * 1024) break;
        var end = off + size;
        if (end > maxEnd) maxEnd = end;
    }
    return { ver: ver, idx: idx, size: maxEnd };
}

function scanRange(base, size) {
    return new Promise(function (resolve) {
        try {
            Memory.scan(base, size, "af 1b b1 fa", {
                onMatch: function (addr) {
                    try {
                        var info = parseChain(addr);
                        if (info.size < 1024 * 1024) return;          // too small = not metadata
                        if (dumped[info.idx]) return;                 // one per idx
                        dumped[info.idx] = true;
                        if (Object.keys(dumped).length > MAXBLOBS) return;
                        console.log("[META] idx=" + info.idx + " ver=" + info.ver +
                                    " size=" + info.size + " @ " + addr);
                        var f = new File(resolveSaveDir() + "mlbb_meta_idx" + info.idx + "_v" + info.ver + ".bin", "wb");
                        f.write(addr.readByteArray(info.size));
                        f.close();
                        console.log("[META] full dump ok -> mlbb_meta_idx" + info.idx);
                    } catch (e) { console.log("[!] hit err: " + e); }
                },
                onComplete: function () { resolve(); }
            });
        } catch (e) { console.log("[!] scan err: " + e); resolve(); }
    });
}

async function scanAll() {
    var ranges = await Process.enumerateRanges('rw-');
    console.log("[*] scanning " + ranges.length + " ranges");
    for (var i = 0; i < ranges.length; i++) {
        if (Object.keys(dumped).length >= MAXBLOBS) break;
        var r = ranges[i];
        if (r.size > 512 * 1024 * 1024) continue;
        await scanRange(r.base, r.size);
    }
    console.log("[DONE] dumped idx: " + Object.keys(dumped).join(","));
}

setTimeout(function () { scanAll(); }, 4000);
setTimeout(function () { console.log("[STAT] done: " + Object.keys(dumped).join(",")); }, 90000);
