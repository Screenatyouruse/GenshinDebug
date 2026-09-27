// MLBB Lua funnel dumper v2 - attach-only, fragment reassembly
// lua_load @ libmoba+0x106C88, custom reader @ libmoba+0x108fa4 (observed)

'use strict';

var count = 0;
var hookedReaders = {};   // reader addr -> true
var currentLoad = {};     // tid -> { name, file, frag, idx }

var moba = Process.findModuleByName("libmoba.so");
if (!moba) {
    console.log("[-] libmoba.so not loaded - wait for main menu and rerun");
} else {
    console.log("[*] libmoba base: " + moba.base);
    var LUA_LOAD = moba.base.add(0x106C88);
    var READER   = moba.base.add(0x108FA4);   // observed custom reader (defensive: hook it even if ptr differs)

    Interceptor.attach(LUA_LOAD, {
        onEnter: function (args) {
            var tid = Process.getCurrentThreadId();
            var name = "<unnamed>";
            try { name = args[3].readUtf8String(); } catch (e) {}
            console.log("[LOAD] " + name);

            // close any stale load on this thread
            closeLoad(tid);

            currentLoad[tid] = { name: name, file: null, frag: 0, idx: count };

            // Plan A: plain LoadS {ptr,size}? (cheap try, custom reader will fail)
            try {
                var s    = args[2].readPointer();
                var size = args[2].add(8).readU64().toNumber();
                if (size > 0 && size < 20 * 1024 * 1024 && !s.isNull()) {
                    saveDump(name + ".whole", Memory.readByteArray(s, size), "loads");
                }
            } catch (e) { /* custom reader - fragments via hook below */ }

            // hook this reader (attach-only!) if not already
            var rp = args[1].toString();
            if (!hookedReaders[rp]) {
                hookedReaders[rp] = true;
                try {
                    Interceptor.attach(args[1], {
                        onEnter: function (a) { this.sizeOut = a[2]; },
                        onLeave: function (retval) {
                            var t = Process.getCurrentThreadId();
                            var st = currentLoad[t];
                            if (!st) return;
                            try {
                                var n = this.sizeOut.readU64().toNumber();
                                if (retval.isNull() || n <= 0) return;   // EOF from reader
                                var bytes = Memory.readByteArray(retval, n);
                                if (st.file === null) {
                                    var safe = st.name.replace(/[^A-Za-z0-9_.@-]/g, "_").substring(0, 60);
                                    st.file = new File("/data/local/tmp/luadumps/" + st.idx + "_stream_" + safe + ".bin", "wb");
                                    st.frag = 0;
                                }
                                st.file.write(bytes);          // appends in call order = correct chunk order
                                console.log("[FRAG] " + st.name + " #" + (st.frag++) + " len=" + n);
                            } catch (e) { console.log("[!] frag err: " + e); }
                        }
                    });
                    console.log("[*] reader hooked @ " + args[1]);
                } catch (e) { console.log("[!] reader hook failed: " + e); }
            }
        },
        onLeave: function (retval) {
            closeLoad(Process.getCurrentThreadId());
        }
    });
    console.log("[*] lua_load hooked @ " + LUA_LOAD);

    // also hook the known reader defensively (idempotent via hookedReaders)
    try {
        var rk = READER.toString();
        if (!hookedReaders[rk]) {
            hookedReaders[rk] = true;
            Interceptor.attach(READER, {
                onEnter: function (a) { this.sizeOut = a[2]; },
                onLeave: function (retval) {
                    var t = Process.getCurrentThreadId();
                    var st = currentLoad[t];
                    if (!st) return;
                    try {
                        var n = this.sizeOut.readU64().toNumber();
                        if (retval.isNull() || n <= 0) return;
                        var bytes = Memory.readByteArray(retval, n);
                        if (st.file === null) {
                            var safe = st.name.replace(/[^A-Za-z0-9_.@-]/g, "_").substring(0, 60);
                            st.file = new File("/data/local/tmp/luadumps/" + st.idx + "_stream_" + safe + ".bin", "wb");
                            st.frag = 0;
                        }
                        st.file.write(bytes);
                        console.log("[FRAG] " + st.name + " #" + (st.frag++) + " len=" + n);
                    } catch (e) {}
                }
            });
            console.log("[*] known reader hooked @ " + READER);
        }
    } catch (e) { console.log("[!] static reader hook failed: " + e); }
}

function closeLoad(tid) {
    var st = currentLoad[tid];
    if (!st) return;
    if (st.file !== null) {
        try { st.file.close(); } catch (e) {}
        console.log("[DONE] " + st.name + " (" + st.frag + " frags)");
    }
    delete currentLoad[tid];
}

function saveDump(name, buf, tag) {
    var safe = String(name).replace(/[^A-Za-z0-9_.@-]/g, "_").substring(0, 60);
    var f = new File("/data/local/tmp/luadumps/" + (count++) + "_" + tag + "_" + safe + ".bin", "wb");
    f.write(buf);
    f.close();
    console.log("[DUMP] " + tag + " " + safe);
}