'use strict';

// MLBB Lua chunk capture v7 - named via lua_load correlation
//
// v6 finding: Lua2LuaC strips the embedded source string (size=0) from
// bytecode chunks, so names only exist at lua_load (+0x106C88) which receives
// the real module path. v7 stashes the name per-thread at lua_load entry and
// attaches it to the next undump/parser capture on the same thread.
//
// offsets (arm64, verified): lua_load +0x106C88, undump +0x124754,
// parser +0x119CFC. ZIO: {n@0, p@8, reader@16, ud@24, L@32, eof@40}.
// zgetc here is a PEEK -> chunk = (p, n) at hook entry.

var count = 0;
var SAVE_DIR = null;
var pendingName = {};      // tid -> chunkname from last lua_load on this thread

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

function captureChunk(kind, zio, name) {
    try {
        var nNum = Number(zio.readU64());
        var p    = zio.add(8).readPointer();
        if (nNum <= 0 || nNum > 32 * 1024 * 1024 || p.isNull()) return;

        var bytes = p.readByteArray(nNum);
        var u8 = new Uint8Array(bytes);
        var isBytecode = (nNum >= 2 && u8[0] === 0x1b && u8[1] === 0x4c);

        var fname = count + "_" + kind + "_" + safeName(name || "<unnamed>") + ".bin";
        var wrote = false;
        try {
            var f = new File(resolveSaveDir() + fname, "wb");
            f.write(bytes); f.close();
            wrote = true;
        } catch (e) { wrote = false; }

        console.log("[CAP] #" + count + " " + kind + " " +
                    (isBytecode ? "BC" : "SRC") + " " + nNum + "B " +
                    (wrote ? "file" : "NOFILE") + " " + (name || "<unnamed>"));
        count++;
    } catch (e) {
        console.log("[!] capture err (" + kind + "): " + e);
    }
}

var moba = Process.findModuleByName("libmoba.so");
if (!moba) {
    console.log("[-] libmoba.so not loaded - wait for main menu, rerun");
} else {
    console.log("[*] dump_v7 alive, libmoba base: " + moba.base);

    var firedUndump = 0, firedParser = 0, firedLoad = 0;

    Interceptor.attach(moba.base.add(0x106C88), {          // lua_load - name source
        onEnter: function (args) {
            firedLoad++;
            var name = null;
            try {
                var s = args[3];
                if (!s.isNull()) {
                    name = s.readUtf8String(96);
                    if (name && name.length > 96) name = name.substring(0, 96);
                }
            } catch (e) {}
            if (name) pendingName[Process.getCurrentThreadId()] = name;
        }
    });

    Interceptor.attach(moba.base.add(0x124754), {          // luaU_undump
        onEnter: function (args) {
            firedUndump++;
            var tid = Process.getCurrentThreadId();
            var name = pendingName[tid] || null;
            delete pendingName[tid];
            captureChunk("undump", args[1], name);
        }
    });

    Interceptor.attach(moba.base.add(0x119CFC), {          // luaY_parser
        onEnter: function (args) {
            firedParser++;
            var tid = Process.getCurrentThreadId();
            var name = pendingName[tid] || null;
            delete pendingName[tid];
            captureChunk("parse", args[1], name);
        }
    });

    console.log("[*] lua_load + undump + parser hooked");

    setInterval(function () {
        console.log("[STAT] load=" + firedLoad + " undump=" + firedUndump +
                    " parser=" + firedParser + " captured=" + count);
    }, 15000);
}
