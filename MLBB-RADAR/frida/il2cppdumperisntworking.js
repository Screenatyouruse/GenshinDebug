'use strict';
// Scan rw- memory for decrypted global-metadata (AF 1B B1 FA), validate, dump.

var MAGIC = [0xaf, 0x1b, 0x1b, 0xfa];
var SAVE_DIR = "/data/user/11/com.mobile.legends/cache/";
var found = 0, MAXDUMP = 3;

function readI32(p) { return p.readInt(); }

function validateHeader(p) {
    var ver = readI32(p.add(4));
    if (ver < 23 || ver > 27) return null;
    var maxSize = 0, plausible = 0;
    for (var i = 8; i + 8 <= 0x108; i += 8) {           // header pair region
        var off = readI32(p.add(i));
        var cnt = readI32(p.add(i + 4));
        if (off < 0x108 || off > 200 * 1024 * 1024) continue;
        if (cnt < 0 || cnt > 5000000) continue;
        plausible++;
        var end = off + cnt * 8;                        // 8 = max element stride
        if (end > maxSize && end < 200 * 1024 * 1024) maxSize = end;
    }
    if (plausible < 20 || maxSize < 1 * 1024 * 1024) return null;   // metadata is MBs
    return { version: ver, size: maxSize };
}

function scanAll() {
    var ranges = Process.enumerateRangesSync('rw-');
    console.log("[*] scanning " + ranges.length + " rw- ranges for metadata magic");
    ranges.forEach(function (r) {
        if (r.size > 512 * 1024 * 1024) return;         // skip monster ranges
        try {
            Memory.scan(r.base, r.size, "af 1b b1 fa", {
                onMatch: function (addr) {
                    if (found >= MAXDUMP) return;
                    var v = validateHeader(addr);
                    if (!v) { console.log("[?] magic @ " + addr + " failed validation"); return; }
                    found++;
                    var f = new File(SAVE_DIR + "metadata_dump_" + found + "_v" + v.version + ".bin", "wb");
                    f.write(addr.readByteArray(v.size)); f.close();
                    console.log("[META] v" + v.version + " size=" + v.size + " @ " + addr + " -> file " + found);
                },
                onComplete: function () {}
            });
        } catch (e) {}
    });
    setTimeout(function () { console.log("[DONE] candidates: " + found); }, 30000);
}

setTimeout(scanAll, 4000);