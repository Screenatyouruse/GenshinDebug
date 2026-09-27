'use strict';

// MLBB Lua chunk capture v6 - named, per-file, no console flooding
//
// Changes vs v5:
//   - module name extracted from the bytecode's embedded source string
//     (Lua 5.1 header = 12 bytes, then {size_t len LE; chars[len-1]; \0})
//   - one file per chunk in the app cache dir, named <idx>_<module>.lua.bin
//   - MIRROR off by default (console stays light; files are the harvest path)
//   - compact one-line [CAP] log per chunk + 15s [STAT] heartbeat
//
// libmoba offsets (arm64, verified in IDA):
//   undump = +0x124754 (L, ZIO*, Mbuffer*, name)   bytecode chunks
//   parser = +0x119CFC (L, ZIO*, Mbuffer*, name)   source chunks
// ZIO this build: { n @0 | p @8 | reader @16 | ud @24 | L @32 | eof @40 }
// zgetc here is a PEEK -> chunk is exactly (p, n) at hook entry.

var count = 0;
var SAVE_DIR = null;
var MIRROR = false;        // set true only if cache-dir harvesting stops working
var DEBUG = false;         // true = print ZIO fields for first 8 chunks

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

function safeName(s) {
    s = String(s).replace(/[^A-Za-z0-9_.@-]/g, "_");
    if (s.length > 80) s = s.substring(0, 80);
    return s;
}

// parse the embedded chunkname out of Lua 5.1 bytecode
function parseEmbeddedName(bytes) {
    try {
        var u8 = new Uint8Array(bytes);
        if (u8.length < 24) return null;
        if (u8[0] !== 0x1b || u8[1] !== 0x4c || u8[2] !== 0x75 || u8[3] !== 0x61) return null;
        if (u8[4] !== 0x51) return null;                 // version 5.1 only
        var off = 12;                                    // 4 sig + 8 header fields
        var len = 0;                                     // size_t, 8 bytes little-endian
        for (var i = 7; i >= 0; i--) len = len * 256 + u8[off + i];
        off += 8;
        if (len <= 0 || len > 4096 || off + len > u8.length) return null;
        var s = "";
        for (var j = 0; j < len - 1; j++) s += String.fromCharCode(u8[off + j]);
        return s;
    } catch (e) { return null; }
}

function manualB64(bytes, idx) {   // kept for emergencies only
    var u8 = new Uint8Array(bytes);
    var T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (var i = 0; i < u8.length; i += 0x8000) {
        var bin = "";
        var end = Math.min(i + 0x8000, u8.length);
        for (var j = i; j < end; j++) bin += String.fromCharCode(u8[j]);
        var b64 = "";
        try { b64 = btoa(bin); } catch (e) {
            for (var k = 0; k < bin.length; k += 3) {
                var a = bin.charCodeAt(k), b = bin.charCodeAt(k + 1), c = bin.charCodeAt(k + 2);
                b64 += T[a >> 2] + T[((a & 3) << 4) | (b >> 4)]
                     + (isNaN(b) ? "=" : T[((b & 15) << 2) | (c >> 6)])
                     + (isNaN(c) ? "=" : T[c & 63]);
            }
        }
        console.log("[B64]" + idx + "|" + i + "|" + b64);
    }
}

var seenZio = 0;
function captureChunk(kind, zio, nameArg) {
    try {
        var nNum = Number(zio.readU64());               // ZIO.n @0 (BigInt -> Number)
        var p    = zio.add(8).readPointer();            // ZIO.p @8

        if (DEBUG && seenZio < 8) {
            seenZio++;
            console.log("[ZIO] n=" + nNum + " p=" + p + " head=" +
                        p.readByteArray(Math.min(8, nNum)) );
        }

        if (nNum <= 0 || nNum > 32 * 1024 * 1024 || p.isNull()) return;

        var bytes = p.readByteArray(nNum);              // whole decrypted chunk
        var u8 = new Uint8Array(bytes);
        var isBytecode = (nNum >= 2 && u8[0] === 0x1b && u8[1] === 0x4c);

        var modName = null;
        if (isBytecode) modName = parseEmbeddedName(bytes);
        if (modName === null || modName === "" || modName === "=") {
            if (nameArg) modName = nameArg;
            else modName = "<unnamed>";
        }

        var fname = count + "_" + kind + "_" + safeName(modName) + ".bin";
        var wrote = false;
        try {
            var f = new File(resolveSaveDir() + fname, "wb");
            f.write(bytes); f.close();
            wrote = true;
        } catch (e) { wrote = false; }

        console.log("[CAP] #" + count + " " + kind + " " +
                    (isBytecode ? "BC" : "SRC") + " " + nNum + "B " +
                    (wrote ? "file" : "NOFILE") + " " + modName);

        if (!wrote && MIRROR) manualB64(bytes, count);
        count++;
    } catch (e) {
        console.log("[!] capture err (" + kind + "): " + e);
    }
}

var moba = Process.findModuleByName("libmoba.so");
if (!moba) {
    console.log("[-] libmoba.so not loaded - wait for main menu, rerun");
} else {
    console.log("[*] dump_v6 alive, libmoba base: " + moba.base);

    var firedUndump = 0, firedParser = 0;

    Interceptor.attach(moba.base.add(0x124754), {          // luaU_undump
        onEnter: function (args) {
            firedUndump++;
            var name = null;
            try { name = args[3].readUtf8String(96); } catch (e) {}
            captureChunk("undump", args[1], name);
        }
    });

    Interceptor.attach(moba.base.add(0x119CFC), {          // luaY_parser (source)
        onEnter: function (args) {
            firedParser++;
            var name = null;
            try { name = args[3].readUtf8String(96); } catch (e) {}
            captureChunk("parse", args[1], name);
        }
    });

    console.log("[*] undump + parser hooked");

    setInterval(function () {
        console.log("[STAT] undump=" + firedUndump + " parser=" + firedParser + " captured=" + count);
    }, 15000);
}
