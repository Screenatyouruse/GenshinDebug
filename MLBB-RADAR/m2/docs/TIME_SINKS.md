# MLBB RE — Time-Sink Postmortem
The things we circled around for hours on 2026-09-10, why each looked right,
what was actually true, and the shortcut. For anyone attempting the same hunt:
if you see the symptom, jump straight to the cause.

## 1. Hunting il2cpp internals in libil2cpp.so (the decoy lib)
Symptom: searched libil2cpp.so for MetadataCache strings, vm symbols, the 0xFAB11BAF
immediate, movz/movk halfwords — ALL empty. Hours of IDA entity searches.
Actual truth: the APK libil2cpp.so is a 412KB SHIM. The real engine is liblogic.so
(28MB, downloaded at runtime to app_libs). liblogic exports every il2cpp_* symbol
with full mangled names (6903 exports).
Shortcut: check `il2cpp_image_get_class` in EVERY loaded module's exports first.
If liblogic.so exports it, everything else is engine work, not APK work.

## 2. il2cpp_init wrapper pointers reading zero
Symptom: m_il2cpp_init_ptr and dllIL2CPPRealHandler both read 0 in a running game,
so we assumed the shim was dead (correct!) but then wasted time on WHY.
Truth: libunity's LoadIl2Cpp dlsym's all 244 il2cpp_* exports from whatever the
Moonton SDK (zorro) loaded — "s_sdk_libLogicPath" string in the error path.
Shortcut: rg the engine binary for `[zorro]` / `s_sdk_libLogicPath` strings.

## 3. IDA auto-analysis hang on 28MB liblogic.so
Symptom: analysis stuck traversing a jump table at .text:0xD3E248, cascading
30+ nested jumptable default cases, AU never idle.
Fix that worked: pause analysis (AU indicator bottom-left), select the junk range,
Undefine (U) + make a byte array (D), resume. Or skip 0xD00000-0xE00000 entirely —
nothing we needed lived below 0xAF53A0. Real work was at 0xAF53A0-0xF914B4 (.text)
and 0xF90CF4-0x12E7268 ("il2cpp" section).
Also: `DELIT_EXPAND` not `DELIT_SIMPLE` — SIMPLE leaves item boundaries blocking
create_insn (we lost 20 minutes to "invalid use of non-static data member"-style
confusion because functions silently failed to materialize).

## 4. Assert strings that reference NOTHING
Symptom: found "il2cpp-Runtime::before_MetadataCache_Initialize#2035" and
"il2cpp-MetadataCache::InitializeMetadataItem_N" strings, then found ZERO code
references by ADRP+ADD scan AND zero .rela.dyn relocation addends.
Truth: asserts compiled out, strings left as dead rodata. Not a bug in your scanner.
Shortcut: the REAL MetadataCache::Initialize is the function whose OWN assert string
is "Initialize_start#2036" — find by decompiling il2cpp_init -> Runtime::Init chain,
not by string xrefs.

## 5. .rela.plt symbol resolution lying
Symptom: BL to PLT stub in liblogic resolved to "Action_2_Invoke_gshared" — nonsense.
Also three different PLT0 offset theories (32/16/0) gave three different wrong names.
Truth: Moonton's "PLT" stubs load pointers from .data slots (R_AARCH64_RELATIVE
relocations to internal thunks), not classic JUMP_SLOT imports.
Shortcut: for this binary, resolve functions by the runtime hook (frida) not by
static PLT tables. The GOT-slot = RELATIVE-to-.data = a decoy trail.

## 6. False-positive ADRP+ADD hits on strings
Symptom: "-metadata.dat" string at 0x53cc74 appeared to be referenced from code at
0xf42d14 — which then turned out to be a 0-byte "empty" function (padding/data).
Truth: my scan matched ADRP+ADD pairs inside DATA regions (the 0x14-byte read
spanned an unanalyzed literal pool).
Shortcut: verify the referencing address is inside a REAL code section and that
IDA (with proper analysis) agrees before chasing a string xref.

## 7. The "room hack" anchor — scanning for class pointers that don't exist
Symptom: resolved Friends.RoomDataManager class handle via il2cpp_class_from_name,
scanned ALL libcsharp + liblogic writable ranges for 8-byte tagged pointers to it
— zero hits, twice, with widening masks.
Truth: Moonton's fork does NOT keep this class in a codegen metadata-usage slot at
all (the slots live in a specific bss window at base+0x7500000, 2MB, and only for
classes the fork's codegen references). RoomDataManager isn't in the table.
Shortcut: skip the slot hunt entirely. Use il2cpp_class_from_name + klass+0xB8
(static fields) + read the _instance field directly. room_dump.js pattern.
(For classes that DO have slots, offsets.ts scans the bss window successfully.)

## 8. Il2CppDumper crashes: the three-stage mystery
Stage 1: "duplicate key 16777393" in fieldDefaultValuesDic — Moonton encodes
cross-blob indices as (fileIndex << 24) | localIndex AND also plain-local form.
Your decoded dictionary needs both forms decoded, not just the encoded one.
Stage 2: "duplicate key 536870913" in attributeTypeRangesDic — images'
customAttributeStart was rebased with BYTE offsets; must be ENTRY-index offsets.
Every index-based section needs per-element unit bases, not byte offsets.
Stage 3: "IndexOutOfRange" during header read — red herring, PDB line numbers in
the release build don't match master source. Don't debug by line number.
Shortcut: verify section bases in ELEMENT units first, decode BOTH index forms.

## 9. Il2CppType array element size (16 vs 12)
Symptom: dumping types arrays produced "access violation" past mapped pages with
elsz=16.
Truth: vanilla Il2CppType (v24.4) = {data u64, bits u32} = 12 bytes. My 16 came
from miscounting the Il2CppDumper C# class (data + bitfield + attrs union overlap).
Shortcut: read the struct class in Il2CppDumper's MetadataClass.cs, never assume.

## 10. fwrite through frida with a Uint8Array
Symptom: "Error: expected a pointer" at the fwrite call while the read succeeded.
Truth: frida 17.9 refuses a Uint8Array as a pointer arg; and even ArrayBuffer
wrap/unwrap is fragile in QJS.
Shortcut: never build intermediate buffers — fwrite(srcPtr, 1, n, fp) directly
from mapped memory in range-checked chunks (and skip unmapped holes by finding
the next mapped range, NOT by jumping to "nextMapped" of the failing page,
which can jump past the entire array — we wrote 0/Y bytes three times).

## 11. frida spawn-gating (--await) timing
Symptom: attaching at fork via --await, hooks installed "before resume" — but
blob1's registration never caught. Also: CLI injection = 2-3s AFTER resume
in practice ("hooks installed only after MLBB title pops up").
Truth: spawn-gating resumes the process BEFORE the agent finishes injecting.
blob1's registration happens in that window. blobs 2/3 fire later and are
catchable with a fast manual attach (LO's "exit right before Moonton symbol,
inject, come back" trick = reliable).
Shortcut: for boot-time captures use LO's manual race. For everything else,
attach to a RUNNING process — static registration structs are readable anytime.

## 12. The JSON in C++ snprintf broke my brace counter
Symptom: brace-depth analysis said the class was unbalanced — but only by ONE
brace, at a line containing `snprintf(..., "],\"n\":%d}\n", ...)`.
Truth: my naive counter counted braces inside string literals.
Shortcut: when validating generated C++, compile it (`g++ -fsyntax-only`),
don't count braces by hand. Also, adding functions by string-replacing
`public:\n    MobaReader(...)` swallowed the constructor signature line —
always re-read the file after bulk edits.

## 13. Il2Cpp string decoding
Symptom: "can't decode byte 0xfe" reading RoomPlayerInfo.strName.
Truth: proto classes use real System.String (UTF-16 at +0x14, len at +0x10),
NOT C strings. readUtf8String on them = garbage/crash.
Shortcut: moba/frida/room_dump.js has the working istr() UTF-16 reader.

## 14. Tagged pointers lossy-converted to JS numbers
Symptom: "not a function" calling .add on rpi in room_dump.js.
Truth: dict values are MTE-tagged (0xb40000...) heap pointers > 2^53;
Number() conversion corrupted them. Must stay NativePointer via ptr(val.toString()).
Shortcut: anything read as BigUint64 from memory and used as an address =
convert with ptr(val.toString()), never Number().

## 15. frida-il2cpp-bridge gotchas
- It looks for "libil2cpp.so" (the shim!) and crashes with access violation at 0.
  Fix: `Il2Cpp.$config.moduleName = "liblogic.so"` BEFORE Il2Cpp.perform.
- Even with that, the lazy getters (@lazy/@recycle) broke under esbuild bundling
  (prototype props missing, image.classes undefined). Diag showed
  proto = [constructor, image, name, object] — the lazy getters never installed.
Shortcut: don't fight it — the raw il2cpp C API (dump_raw.js pattern) does
everything the bridge does with zero build steps.
- Building the bridge on Windows: `npm exec tspc` directly (no Make/make).
  esbuild for bundling: `npm.cmd exec esbuild -- --bundle --outfile=... input.ts`.

## 16. Port.json pull failure
Symptom: "pull failed — bootstrap may not have written port.json" while the log
showed the write succeeded. Truth: /data/user/11/.../cache/ is not adb-readable.
Shortcut: the su .sh cat-to-tmp pattern (rule #1). Also: refresh-offsets.cmd's
frida step hung because the piped exit wasn't consumed with a second pipe
(| findstr) — use background+timeout+taskkill (fixed in the cmd).

## 17. CPS/binary field offset transposition
Symptom: emitTopDict referenced `dic` in one place and `dict` in another — the
draft-mode room reader crashed at runtime on a real room.
Truth: hand-writing 100+ lines of C++ in one pass = variable-name typos that
only surface on real data. Compile-check (WSL g++ -fsyntax-only) BEFORE pushing
to the device.

## 18. Wrong-class traps in the dump
- GameRTCML.RoomInfo = the VOICE/RTC room (Agora). Not the match room.
- MTTDProto.RoomBattleInfo = custom-room metadata (name/password), not draft state.
- MCBanPickCommander = Magic Chess ban-pick, not ranked draft.
- Cheat class = the game's built-in cheat-CODE console, not the anticheat.
Shortcut: read the namespace before trusting a promising class name.

## Meta-lesson

Three hours of the day went into tools that a 5-minute frida probe would have
disproven (libil2cpp hunt, slot scan, static registration hunt). The dynamic
probe FIRST, the static analysis SECOND — always in that order. The static work
paid off in durability (dump.cs, merge.py, the format decode), but every dead end
was a static assumption that one live probe would have killed instantly.
