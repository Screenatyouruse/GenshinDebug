// probe_engine.js — run attached to the game
var il2 = Process.findModuleByName("libil2cpp.so");
console.log("[*] module: " + il2.path + " base=" + il2.base + " size=" + il2.size);

// version check: read wrapper prologue bytes, compare with our IDB
console.log("[*] prologue @+0x2f080: " + hex(il2.base.add(0x2f080), 32));

var initPtr = il2.base.add(0x65690).readPointer();
var handler = il2.base.add(0x65e18).readPointer();
console.log("[*] m_il2cpp_init_ptr = " + initPtr);
console.log("[*] dllIL2CPPRealHandler = " + handler);

var mods = Process.enumerateModules();
function who(a) {
    var hit = mods.find(function (m) { return a.compare(m.base) >= 0 && a.compare(m.base.add(m.size)) < 0; });
    return hit ? hit.name + " +0x" + a.sub(hit.base).toString(16) : "<not a module>";
}
if (!initPtr.isNull()) console.log("[*] real Runtime::Init in: " + who(initPtr));
if (!handler.isNull()) {
    // dlopen handle → point it at the soinfo; instead just check the wrapper's
    // call target by also reading the utf16 twin for cross-check
    console.log("[*] utf16 ptr = " + il2.base.add(0x65698).readPointer() + " in " + who(il2.base.add(0x65698).readPointer()));
}
function hex(addr, n) {
    var u8 = new Uint8Array(addr.readByteArray(n)), s = "";
    for (var i = 0; i < u8.length; i++) s += ("0" + u8[i].toString(16)).slice(-2) + " ";
    return s;
}