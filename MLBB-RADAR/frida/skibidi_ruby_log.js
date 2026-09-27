// skibidi_ruby_log.js — Logs all set_text calls and replaces target titles.
// Run with: frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l moba/frida/skibidi_ruby_log.js --runtime qjs -q

const lib = Process.getModuleByName("liblogic.so");
const E = (n, r, a) => new NativeFunction(lib.getExportByName(n), r, a);

const domainGet = E("il2cpp_domain_get", "pointer", []);
const threadAttach = E("il2cpp_thread_attach", "pointer", ["pointer"]);
const domainGetAssemblies = E("il2cpp_domain_get_assemblies", "pointer", ["pointer", "pointer"]);
const assemblyGetImage = E("il2cpp_assembly_get_image", "pointer", ["pointer"]);
const classFromName = E("il2cpp_class_from_name", "pointer", ["pointer", "pointer", "pointer"]);
const classGetMethods = E("il2cpp_class_get_methods", "pointer", ["pointer", "pointer"]);
const methodGetName = E("il2cpp_method_get_name", "pointer", ["pointer"]);
const methodGetParamCount = E("il2cpp_method_get_param_count", "uint32", ["pointer"]);
const strNew = E("il2cpp_string_new", "pointer", ["pointer"]);

function cstr(p) { return p.isNull() ? "" : p.readUtf8String(); }

// Reads Il2Cpp System.String (UTF-16 chars at +0x14, int32 len at +0x10)
function istr(p) {
    if (p.isNull() || p.toUInt32() < 0x1000) return "";
    try {
        const len = p.add(0x10).readS32();
        if (len <= 0 || len > 512) return "";
        const b = p.add(0x14).readByteArray(len * 2);
        const dv = new DataView(b);
        let s = "";
        for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(i * 2, true));
        return s;
    } catch (e) {
        return "";
    }
}

// Keep allocated Il2Cpp strings rooted so GC doesn't touch them before assignment
const allocatedStrings = [];
function makeIl2CppString(str) {
    const s = strNew(Memory.allocUtf8String(str));
    allocatedStrings.push(s);
    if (allocatedStrings.length > 200) allocatedStrings.shift();
    return s;
}

function findKlass(ns, name) {
    const d = domainGet();
    const sb = Memory.alloc(8);
    const asms = domainGetAssemblies(d, sb);
    const n = sb.readU64().toNumber();
    const mk = (s) => Memory.allocUtf8String(s);
    for (let i = 0; i < n; i++) {
        const img = assemblyGetImage(asms.add(i * Process.pointerSize).readPointer());
        if (img.isNull()) continue;
        const k = classFromName(img, mk(ns), mk(name));
        if (!k.isNull()) return k;
    }
    return null;
}

// Set to true if you only want to see each unique string printed once (avoids 60fps timer spam)
const DEDUP_LOGS = false;
const seen = new Set();

function hookSetText(klass, label) {
    if (!klass) return;
    const iter = Memory.alloc(8);
    let m = classGetMethods(klass, iter);
    let hooked = 0;

    while (!m.isNull()) {
        try {
            const mName = cstr(methodGetName(m));
            const argc = methodGetParamCount(m);

            if (mName === "set_text" && argc === 1) {
                const code = m.readPointer(); // MethodInfo.methodPointer @ +0x0
                console.log(`[*] Hooking ${label}.set_text @ ${code}`);

                Interceptor.attach(code, {
                    onEnter: function (args) {
                        const strPtr = args[1];
                        if (strPtr.isNull() || strPtr.toUInt32() < 0x1000) return;

                        const text = istr(strPtr);
                        if (!text || text.trim().length === 0) return;

                        // Log every text
                        if (!DEDUP_LOGS || !seen.has(text)) {
                            if (DEDUP_LOGS) seen.add(text);
                            console.log(`[TEXT][${label}] "${text}"`);
                        }

                        // Target swap
                        if (/Global\s*10\s*Ruby/i.test(text)) {
                            console.log(`[🎯 HIT] Found target: "${text}"`);
                            const replaced = text.replace(/Global\s*10\s*Ruby/gi, "GLOBAL 10 SKIBIDI TOILET");
                            args[1] = makeIl2CppString(replaced);
                            console.log(`[✨ SWAP] Mutated to: "${replaced}"`);
                        }
                    }
                });
                hooked++;
            }
        } catch (e) { }
        m = classGetMethods(klass, iter);
    }
    if (hooked === 0) console.log(`[!] No set_text found for ${label}`);
}

function init() {
    const domain = domainGet();
    if (domain.isNull()) {
        console.log("[-] il2cpp domain is null, retrying in 1s...");
        setTimeout(init, 1000);
        return;
    }
    threadAttach(domain);

    const uiText = findKlass("UnityEngine.UI", "Text");
    hookSetText(uiText, "UnityEngine.UI.Text");

    const tmpText = findKlass("TMPro", "TMP_Text");
    hookSetText(tmpText, "TMPro.TMP_Text");

    console.log("[*] Logging active! Navigating UI menus will dump incoming strings...");
}

init();
