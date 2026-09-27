// cmdspy.js — log which MTTDProto Cmd_*_CS / Cmd_*_SC messages the client builds.
// Installs a ctor hook on every class named Cmd_<...>_CS / Cmd_<...>_SC and logs
// each message TYPE once. Use it to identify the message behind an action
// (e.g. open a profile -> which request/response fires).
//
// raw il2cpp C API. run:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l cmdspy.js --runtime qjs
//
// do the action (ID search / open a profile), then paste the [req]/[rsp] lines.

const lib = Process.getModuleByName("liblogic.so");
const E = (n, r, a) => new NativeFunction(lib.getExportByName(n), r, a);

const domainGet = E("il2cpp_domain_get", "pointer", []);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const imageGetClassCount = E("il2cpp_image_get_class_count", "uint32", ["pointer"]);
const imageGetClass = E("il2cpp_image_get_class", "pointer", ["pointer", "uint32"]);
const classGetName = E("il2cpp_class_get_name", "pointer", ["pointer"]);
const classGetMethods = E("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"]);
const methodGetName = E("il2cpp_method_get_name", "pointer", ["pointer"]);
const methodGetParamCount = E("il2cpp_method_get_param_count", "uint32", ["pointer"]);

function cstr(p) { return p.isNull() ? "" : p.readUtf8String(); }
function sym(addr) {
    try {
        const m = Process.findModuleByAddress(addr);
        if (m) return m.name + "+0x" + addr.sub(m.base).toString(16);
    } catch (e) { /* */ }
    return addr.toString();
}
function methodAddr(klass, name, argc) {
    const iter = Memory.alloc(8);
    let m = classGetMethods(klass, iter);
    while (!m.isNull()) {
        try {
            if (cstr(methodGetName(m)) === name && methodGetParamCount(m) === argc) return m.readPointer();
        } catch (e) { /* */ }
        m = classGetMethods(klass, iter);
    }
    return null;
}

const lastLog = {};   // name -> ts, log on 1s cooldown (not once) so later actions still show
let hooks = 0;

const domain = domainGet();
const sb = Memory.alloc(8);
const asms = domainGetAssemblies(domain, sb);
const n = sb.readU64().toNumber();
for (let i = 0; i < n; i++) {
    let img;
    try { img = assemblyGetImage(asms.add(i * Process.pointerSize).readPointer()); } catch (e) { continue; }
    if (img.isNull()) continue;
    let cc = 0;
    try { cc = imageGetClassCount(img); } catch (e) { continue; }
    for (let j = 0; j < cc; j++) {
        let k;
        try { k = imageGetClass(img, j); } catch (e) { continue; }
        if (k.isNull()) continue;
        let name = "";
        try { name = cstr(classGetName(k)); } catch (e) { continue; }
        if (!/^Cmd_/.test(name) || /Frame/.test(name)) continue;   // all Cmds (incl. Notify), skip battle-frame spam
        const isReq = name.slice(-3) === "_CS";
        const a = methodAddr(k, ".ctor", 0);
        if (!a || a.isNull()) continue;
        try {
            Interceptor.attach(a, {
                onEnter() {
                    const now = Date.now();
                    if (!lastLog[name] || now - lastLog[name] > 1000) {
                        lastLog[name] = now;
                        const tag = name.slice(-3) === "_CS" ? "[req]" : (name.slice(-3) === "_SC" ? "[rsp]" : "[msg]");
                        console.log(tag + " " + name + "  @" + sym(a));
                    }
                },
            });
            hooks++;
        } catch (e) { /* */ }
        if (hooks >= 3000) break;
    }
    if (hooks >= 3000) break;
}

console.log("[*] cmdspy hooks=" + hooks + " — do the action now, paste [req]/[rsp] lines");
