// dump_raw.js — dumper on the raw il2cpp C API. Writes dump_raw.cs.
const OUT = "/data/user/0/com.mobile.legends/cache/ilregs/dump_raw.cs";

const lib = Process.getModuleByName("liblogic.so");
const E = (name, ret, args) => new NativeFunction(lib.getExportByName(name), ret, args);
const domainGet = E("il2cpp_domain_get", "pointer", []);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const imageGetName = E("il2cpp_image_get_name", "pointer", ["pointer"]);
const imageGetClassCount = E("il2cpp_image_get_class_count", "uint32", ["pointer"]);
const imageGetClass = E("il2cpp_image_get_class", "pointer", ["pointer", "uint32"]);
const classGetName = E("il2cpp_class_get_name", "pointer", ["pointer"]);
const classGetNamespace = E("il2cpp_class_get_namespace", "pointer", ["pointer"]);
const classGetParent = E("il2cpp_class_get_parent", "pointer", ["pointer"]);
const classGetFields = E("il2cpp_class_get_fields", "pointer", ["pointer", "pointer"]);
const classGetMethods = E("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"]);
const fieldGetName = E("il2cpp_field_get_name", "pointer", ["pointer"]);
const fieldGetOffset = E("il2cpp_field_get_offset", "size_t", ["pointer"]);
const fieldGetType = E("il2cpp_field_get_type", "pointer", ["pointer"]);
const methodGetName = E("il2cpp_method_get_name", "pointer", ["pointer"]);
const methodGetReturnType = E("il2cpp_method_get_return_type", "pointer", ["pointer"]);
const methodGetParamCount = E("il2cpp_method_get_param_count", "uint32", ["pointer"]);
const methodGetParam = E("il2cpp_method_get_param", "pointer", ["pointer", "uint32"]);
const typeName = E("il2cpp_type_get_name", "pointer", ["pointer"]);
const free = E("free", "void", ["pointer"]);
const libc = Process.getModuleByName("libc.so");
const fopen = new NativeFunction(libc.getExportByName("fopen"), "pointer", ["pointer", "pointer"]);
const fwrite = new NativeFunction(libc.getExportByName("fwrite"), "ulong", ["pointer", "ulong", "ulong", "pointer"]);
const fclose = new NativeFunction(libc.getExportByName("fclose"), "int", ["pointer"]);
const mkdir = new NativeFunction(libc.getExportByName("mkdir"), "int", ["pointer", "int"]);

const cstr = (p) => (p.isNull() ? "" : p.readUtf8String());
const typeStr = (t) => {
    if (t.isNull()) return "?";
    const p = typeName(t);
    const s = p.readUtf8String();
    free(p);
    return s;
};

function main() {
    console.log("[*] step: mkdir");
    mkdir(Memory.allocUtf8String("/data/user/0/com.mobile.legends/cache/ilregs/"), 493);
    console.log("[*] domainGet...");
    const domain = domainGet();
    if (domain.isNull()) { console.log("[!] no domain"); return; }
    console.log("[*] domain = " + domain);
    const sizeBuf = Memory.alloc(8);
    console.log("[*] domainGetAssemblies...");
    const assemblies = domainGetAssemblies(domain, sizeBuf);
    const count = sizeBuf.readU64().toNumber();
    console.log("[*] assemblies: " + count + " at " + assemblies);

    const fp = fopen(Memory.allocUtf8String(OUT), Memory.allocUtf8String("wb"));
    let buf = "";
    let flushed = 0;
    const flush = () => {
        if (buf.length === 0) return;
        const p = Memory.allocUtf8String(buf);
        fwrite(p, 1, buf.length, fp);
        flushed += buf.length;
        buf = "";
    };
    const put = (s) => {
        buf += s + "\n";
        if (buf.length > 262144) flush();
    };

    for (let i = 0; i < count; i++) {
        const asm = assemblies.add(i * Process.pointerSize).readPointer();
        const image = assemblyGetImage(asm);
        const imgName = cstr(imageGetName(image));
        put("// Image " + imgName);
        console.log("[*] image " + imgName + " @" + image);
        const n = imageGetClassCount(image);
        console.log("[*] classes: " + n);
        let bad = 0;
        for (let c = 0; c < n; c++) {
            let klass;
            try { klass = imageGetClass(image, c); } catch (e) { continue; }
            if (klass.isNull()) continue;
            try {
            const name = cstr(classGetName(klass));
            const ns = cstr(classGetNamespace(klass));
            put("// Namespace: " + ns);
            put("public class " + name + " // " + ns + "." + name);
            put("{");
            let iter = Memory.alloc(Process.pointerSize); iter.writePointer(ptr(0));
            let f = classGetFields(klass, iter);
            while (!f.isNull()) {
                const fname = cstr(fieldGetName(f));
                const foff = fieldGetOffset(f);
                const ftype = typeStr(fieldGetType(f));
                put("\t" + ftype + " " + fname + "; // 0x" + foff.toString(16));
                f = classGetFields(klass, iter);
            }
            iter = Memory.alloc(Process.pointerSize); iter.writePointer(ptr(0));
            let m = classGetMethods(klass, iter);
            while (!m.isNull()) {
                const mname = cstr(methodGetName(m));
                const ret = typeStr(methodGetReturnType(m));
                let params = "";
                const pc = methodGetParamCount(m);
                for (let p = 0; p < pc; p++) {
                    const pa = methodGetParam(m, p);
                    params += (p ? ", " : "") + typeStr(pa.add(16).readPointer());
                }
                const mptr = m.readPointer();
                const rva = mptr.isNull() ? "?" : "0x" + mptr.toString(16);
                put("\t" + ret + " " + mname + "(" + params + "); // @" + rva);
                m = classGetMethods(klass, iter);
            }
            put("}");
            } catch (e) { put("// <skipped: " + e + ">"); }
        }
        console.log("[*] " + imgName + ": " + n + " classes done");
    }
    flush();
    fclose(fp);
    console.log("[*] dump_raw.cs written (" + flushed + " bytes flushed)");
}
main();