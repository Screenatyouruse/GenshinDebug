// field_offsets_demo.js — read instance field offsets for a known typedef.
// blob3 (Assembly-CSharp): fieldOffsets array = per-typedef pointers to int32 offset arrays.
// AntiCheatReporter: merged typedef 13424 -> blob3 local 13424-7001 = 6423, 9 fields.
const libc = Process.getModuleByName("libc.so");
const fopen = new NativeFunction(libc.getExportByName("fopen"), "pointer", ["pointer", "pointer"]);
const fwrite = new NativeFunction(libc.getExportByName("fwrite"), "ulong", ["pointer", "ulong", "ulong", "pointer"]);
const fclose = new NativeFunction(libc.getExportByName("fclose"), "int", ["pointer"]);

const cs = Process.getModuleByName("libcsharp.so");
const mreg3 = cs.base.add(0x6f43fe0);
const foCount = mreg3.add(80).readU32();
const foPtr = mreg3.add(88).readPointer();
console.log("[*] fieldOffsets array: count=" + foCount + " ptr=" + foPtr);

// names from the merged metadata (typedef 13424, fieldStart 79393, 9 fields)
var FIELDS = ["iMaxSkillCount", "iCurrentFrame", "MAX_REPORT_STEP", "iReportStep",
              "currentEntry", "indices", "entries", "trans", "bHasRecord"];

const localIdx = 13424 - 7001;
const arrPtr = foPtr.add(localIdx * 8).readPointer();
console.log("[*] fieldOffsets[" + localIdx + "] = " + arrPtr);

let out = "// AntiCheatReporter (blob3 typedef local " + localIdx + ") instance field offsets:\n";
for (let i = 0; i < FIELDS.length; i++) {
    const off = arrPtr.add(i * 4).readS32();
    console.log("  " + FIELDS[i] + " = 0x" + (off < 0 ? "?" : off.toString(16)));
    out += FIELDS[i] + " = 0x" + (off < 0 ? "?" : off.toString(16)) + "\n";
}

mkdirStuffAndSave(out);

function mkdirStuffAndSave(text) {
    mkdir();
    const fp = fopen(Memory.allocUtf8String("/data/user/11/com.mobile.legends/cache/ilregs/field_offsets_demo.txt"), Memory.allocUtf8String("wb"));
    if (!fp.isNull()) {
        const p = Memory.allocUtf8String(text);
        let n = 0;
        for (const ch of text) n += 1; // ascii only
        fwrite(p, 1, text.length, fp);
        fclose(fp);
        console.log("[*] saved field_offsets_demo.txt");
    }
}
function mkdir() {
    const mkdirFn = new NativeFunction(libc.getExportByName("mkdir"), "int", ["pointer", "int"]);
    mkdirFn(Memory.allocUtf8String("/data/user/11/com.mobile.legends/cache/ilregs/"), 493);
}
