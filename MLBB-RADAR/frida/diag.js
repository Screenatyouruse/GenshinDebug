var cs = Process.findModuleByName("libcsharp.so");
if (!cs) {
    console.log("[!] no libcsharp");
} else {
    console.log("[*] libcsharp @ " + cs.base);
    var mreg3 = cs.base.add(0x6f43fe0);
    var typesCnt = mreg3.add(48).readU32();
    var typesPtr = mreg3.add(56).readPointer();
    console.log("[*] typesCnt=" + typesCnt + " typesPtr=" + typesPtr);
    var b = typesPtr.readByteArray(64);
    console.log("[*] got ArrayBuffer, byteLength=" + b.byteLength);
    console.log(hexdump(typesPtr, { length: 64, ansi: false }));

    var libc = Process.getModuleByName("libc.so");
    var fopen = new NativeFunction(libc.getExportByName("fopen"), "pointer", ["pointer", "pointer"]);
    var fwrite = new NativeFunction(libc.getExportByName("fwrite"), "ulong", ["pointer", "ulong", "ulong", "pointer"]);
    var fclose = new NativeFunction(libc.getExportByName("fclose"), "int", ["pointer"]);
    var fp = fopen(Memory.allocUtf8String("/data/user/11/com.mobile.legends/cache/ilregs/diag.bin"), Memory.allocUtf8String("wb"));
    console.log("[*] fopen -> " + fp);
    var n = fwrite(b, 1, 64, fp);
    console.log("[*] fwrite -> " + n);
    fclose(fp);
    console.log("[*] diag done");
}
