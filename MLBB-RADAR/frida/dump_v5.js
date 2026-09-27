'use strict';

// MLBB Lua chunk capture v5 - post-decryption, ZIO-level, zero reader assumptions
//
// libmoba offsets (arm64, verified in IDA):
//   undump  = +0x124754  sub_124754(L, ZIO*, Mbuffer*, name)  <- bytecode chunks
//   parser  = +0x119CFC  sub_119CFC(L, ZIO*, Mbuffer*, name)  <- source chunks
//   zgetc   = +0x127504  sub_127504(ZIO*)  (peek: z->n!=0 ? *z->p : reader(...))
//   lua_load= +0x106C88
//
// ZIO (this build): { size_t n @0 | const char* p @8 | reader @16 | ud @24 | L @32 | eof @40 }
// At undump/parser entry: header byte NOT consumed (zgetc is a peek) -> chunk = (p, n) exactly.
//
// Frida 17: readU64() returns BigInt -> always Number() it.

var count = 0;
var SAVE_DIR = null;
var MIRROR = true;
var DEBUG = true;          // hexdump ZIO + first bytes
var seenZio = 0;

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

function manualB64(bytes, idx) {
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

function safeName(s) { return String(s).replace(/[^A-Za-z0-9_.@-]/g, "_").substring(0, 60); }

function hexAt(ptr, len) {
    try {
        var u8 = new Uint8Array(ptr.readByteArray(len));   // Frida 17: NativePointer method
        var s = "";
        for (var i = 0; i < u8.length; i++) s += ("0" + u8[i].toString(16)).slice(-2) + " ";
        return s.trim();
    } catch (e) { return "<unreadable>"; }
}

function captureChunk(kind, zio, name) {
    try {
        var nNum = Number(zio.readU64());           // ZIO.n  @0
        var p    = zio.add(8).readPointer();        // ZIO.p  @8

        if (DEBUG && seenZio < 8) {
            seenZio++;
            console.log("[ZIO] n=" + nNum + " p=" + p +
                        " reader=" + zio.add(16).readPointer() +
                        " ud=" + zio.add(24).readPointer() +
                        " L=" + zio.add(32).readPointer() +
                        " head=" + hexAt(p, 8));
        }

        if (nNum <= 0) { console.log("[CAP] " + kind + " EMPTY n=0 name=" + name); return; }
        if (nNum > 32 * 1024 * 1024) { console.log("[CAP] " + kind + " huge n=" + nNum + " name=" + name); return; }
        if (p.isNull()) { console.log("[CAP] " + kind + " null p name=" + name); return; }

        var bytes = p.readByteArray(nNum);          // Frida 17: NativePointer method
        var head = new Uint8Array(bytes, 0, Math.min(4, nNum));
        var isBytecode = (nNum >= 2 && head[0] === 0x1b && head[1] === 0x4c);
        var kind2 = isBytecode ? "BYTECODE" : "SOURCE";
        console.log("[CAP] " + kind + " " + kind2 + " name=" + name + " len=" + nNum +
                    " head=" + hexAt(p, 4));

        try {
            var f = new File(resolveSaveDir() + count + "_" + kind + "_" + safeName(name) + ".bin", "wb");
            f.write(bytes); f.close();
            console.log("[CAP] file ok #" + count);
        } catch (e) {
            console.log("[CAP] file write failed (" + e + ") - console mirror only");
        }

        if (MIRROR && nNum <= 4 * 1024 * 1024) manualB64(bytes, count);
        count++;
    } catch (e) {
        console.log("[!] capture err (" + kind + "): " + e + "\n" + e.stack);
    }
}

var moba = Process.findModuleByName("libmoba.so");
if (!moba) {
    console.log("[-] libmoba.so not loaded - wait for main menu, rerun");
} else {
    console.log("[*] libmoba base: " + moba.base);

    var firedUndump = 0, firedParser = 0;

    Interceptor.attach(moba.base.add(0x124754), {          // luaU_undump
        onEnter: function (args) {
            firedUndump++;
            var name = "<unnamed>";
            try { name = args[3].readUtf8String(128); } catch (e) {}
            if (DEBUG && firedUndump <= 8) console.log("[HIT] undump #" + firedUndump + " name=" + name);
            captureChunk("undump", args[1], name);
        }
    });
    console.log("[*] undump hooked @ +" + moba.base.add(0x124754).sub(moba.base));

    Interceptor.attach(moba.base.add(0x119CFC), {          // luaY_parser (source)
        onEnter: function (args) {
            firedParser++;
            var name = "<unnamed>";
            try { name = args[3].readUtf8String(128); } catch (e) {}
            if (DEBUG && firedParser <= 8) console.log("[HIT] parser #" + firedParser + " name=" + name);
            captureChunk("parse", args[1], name);
        }
    });
    console.log("[*] parser hooked @ +" + moba.base.add(0x119CFC).sub(moba.base));

    setInterval(function () {
        console.log("[STAT] undump=" + firedUndump + " parser=" + firedParser + " captured=" + count);
    }, 15000);
}
