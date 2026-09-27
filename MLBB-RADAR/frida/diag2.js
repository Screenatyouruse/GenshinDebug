var cs = Process.findModuleByName("libcsharp.so");
var libc = Process.getModuleByName("libc.so");
var fopen = new NativeFunction(libc.getExportByName("fopen"), "pointer", ["pointer", "pointer"]);
var fwrite = new NativeFunction(libc.getExportByName("fwrite"), "ulong", ["pointer", "ulong", "ulong", "pointer"]);
var fclose = new NativeFunction(libc.getExportByName("fclose"), "int", ["pointer"]);

var mreg3 = cs.base.add(0x6f43fe0);
var typesCnt = mreg3.add(48).readU32();
var typesPtr = mreg3.add(56).readPointer();
console.log("[*] typesCnt=" + typesCnt + " typesPtr=" + typesPtr);

var fp = fopen(Memory.allocUtf8String("/data/user/11/com.mobile.legends/cache/ilregs/blob3_types.bin"), Memory.allocUtf8String("wb"));
console.log("[*] fopen -> " + fp);
var total = typesCnt * 12;
var got = 0;
var p = 0;
while (p < total) {
    var n = Math.min(1048576, total - p);
    var r = fwrite(typesPtr.add(p), 1, n, fp);
    console.log("[*] chunk at +0x" + p.toString(16) + " wrote " + r + "/" + n);
    got += r;
    p += r;
    if (r === 0) break;
}
fclose(fp);
console.log("[*] done: " + got + "/" + total);
