// hook_register_moba.js — capture il2cpp_codegen_register_moba calls at game boot
// usage: frida -U -f <game> -l hook_register_moba.js  OR attach + restart game
// target: liblogic.so!0xf8e5c4  (CodeRegistration*, MetadataRegistration*, options, int, int, const char*)

console.log("Hello world!")

function hookRegister() {
    var lib = Process.findModuleByName("liblogic.so");
    if (!lib) { setTimeout(hookRegister, 500); return; }
    var base = lib.base;
    console.log("[*] liblogic @ " + base);

    // bypass the SDKReport-style wrapper if register_moba is indirect — hook the export directly
    Interceptor.attach(base.add(0xf8e5c4), {
        onEnter: function (args) {
            report(args, "register_moba");
        }
    });
    Interceptor.attach(base.add(0xf8e5b0), {
        onEnter: function (args) {
            report(args, "codegen_register");
        }
    });
    console.log("[*] hooks installed");
}

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
hookRegister();
