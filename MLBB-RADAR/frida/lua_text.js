// lua_text.js — Hook MLBB NGUI (UILabel) & TextMesh to log text & swap titles
// Run with:
//   frida -H 127.0.0.1:27043 -p <pid> -l lua_text.js --runtime qjs -q
// or:
//   frida -H 127.0.0.1:27043 -n "com.mobile.legends:UnityKillsMe" -l lua_text.js --runtime qjs -q

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

// Keep allocated Il2Cpp strings rooted in memory so GC doesn't touch them
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

// Set to true if you only want to see each unique string printed once
const DEDUP_LOGS = false;
const seen = new Set();

function hookClassMethod(klass, label, targetMethod, targetArgc) {
    if (!klass) {
        console.log(`[-] Class ${label} not found`);
        return 0;
    }
    const iter = Memory.alloc(8);
    let m = classGetMethods(klass, iter);
    let hooked = 0;

    while (!m.isNull()) {
        try {
            const mName = cstr(methodGetName(m));
            const argc = methodGetParamCount(m);

            if (mName === targetMethod && argc === targetArgc) {
                const code = m.readPointer(); // MethodInfo.methodPointer @ +0x0
                console.log(`[*] Hooked ${label}.${mName} @ ${code}`);

                Interceptor.attach(code, {
                    onEnter: function (args) {
                        const strPtr = args[1];
                        if (strPtr.isNull() || strPtr.toUInt32() < 0x1000) return;

                        const text = istr(strPtr);
                        if (!text || text.trim().length === 0) return;

                        if (!DEDUP_LOGS || !seen.has(text)) {
                            if (DEDUP_LOGS) seen.add(text);
                            console.log(`[TEXT][${label}] "${text}"`);
                        }

                        // Target title replacements
                        if (/Global\s*No\.?\s*66\s*Edith/i.test(text)) {
                            console.log(`[🎯 HIT] Target detected: "${text}"`);
                            const replaced = text.replace(/Global\s*No\.?\s*66\s*Edith/gi, "#1 Best Edith Player");
                            args[1] = makeIl2CppString(replaced);
                            console.log(`[✨ SWAP] Mutated to: "${replaced}"`);
                        } else if (/Global\s*10\s*Ruby/i.test(text)) {
                            console.log(`[🎯 HIT] Target detected: "${text}"`);
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
    return hooked;
}

function init() {
    const domain = domainGet();
    if (domain.isNull()) {
        console.log("[-] il2cpp domain is null, retrying in 1s...");
        setTimeout(init, 1000);
        return;
    }
    threadAttach(domain);

    // MLBB uses NGUI (UILabel with empty namespace) for virtually all 2D UI & text!
    const uiLabel = findKlass("", "UILabel");
    const h1 = hookClassMethod(uiLabel, "UILabel", "set_text", 1);

    // Also hook 3D text mesh just in case
    const textMesh = findKlass("UnityEngine", "TextMesh");
    const h2 = hookClassMethod(textMesh, "UnityEngine.TextMesh", "set_text", 1);

    console.log(`[*] Hooks installed (UILabel=${h1}, TextMesh=${h2}).`);
    console.log("[*] Live text sniffer active! Navigate menus or profile...");
}

init();

// Keep script alive and prevent Frida CLI from exiting
setInterval(() => { }, 1000);
