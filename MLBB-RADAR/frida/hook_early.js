// hook_early.js — run via: frida -H 127.0.0.1:27043 -f com.mobile.legends -l hook_early.js
// Installs registration hooks in the PARENT at spawn-pause; the UnityKillsMe child
// inherits them through fork. Catches ALL registrations including blob1 (mscorlib).

function report(args, which) {
    var codeReg = args[0], metaReg = args[1];
    console.log("=== " + which + " call ===");
    console.log("  CodeRegistration=" + codeReg + " MetadataRegistration=" + metaReg);
    if (which === "register_moba") {
        console.log("  int1=" + args[3].toInt32() + " int2=" + args[4].toInt32() + " name=\"" + args[5].readCString() + "\"");
    }
    var w = new Array(16);
    for (var j = 0; j < 16; j++) w[j] = metaReg.add(j * 4).readU32();
    console.log("  metaReg[0..15] u32: " + w.map(function (x) { return "0x" + x.toString(16); }).join(" "));
    console.log("  -> typesCount(u64@48)=" + metaReg.add(48).readU64() + " typesPtr=" + metaReg.add(56).readPointer());
    var cw = new Array(8);
    for (var j = 0; j < 8; j++) cw[j] = codeReg.add(j * 4).readU32();
    console.log("  codeReg[0..7] u32: " + cw.map(function (x) { return "0x" + x.toString(16); }).join(" "));
}

function install(lib) {
    var base = lib.base;
    console.log("[*] liblogic @ " + base + " — installing hooks");
    Interceptor.attach(base.add(0xf8e5c4), function (args) { report(args, "register_moba"); });
    Interceptor.attach(base.add(0xf8e5b0), function (args) { report(args, "codegen_register"); });
    console.log("[*] hooks live (parent-installed, will be inherited by fork)");
}

// liblogic may already be mapped (or loads via dlopen later)
var existing = Process.findModuleByName("liblogic.so");
if (existing) {
    install(existing);
} else {
    console.log("[*] liblogic not mapped yet — watching dlopen");
    ["android_dlopen_ext", "dlopen"].forEach(function (fn) {
        var p = null;
        try {
            p = Module.getExportByName(null, fn);
        } catch (e) {
            p = null;
        }
        if (p) {
            Interceptor.attach(p, {
                onEnter: function (a) { this.name = a[0].readCString(); },
                onLeave: function (r) {
                    if (this.name && this.name.indexOf("liblogic.so") !== -1) {
                        var lib = Process.findModuleByName("liblogic.so");
                        if (lib && !this.done) {
                            this.done = true;
                            install(lib);
                        }
                    }
                }
            });
        }
    });
}
console.log("[*] early hook script ready");
