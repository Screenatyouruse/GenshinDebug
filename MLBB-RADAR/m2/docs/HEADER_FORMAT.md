# MLBB Moonton metadata header — DECODED (confirmed on metahit_1 idx=3 + metahit_2 idx=1)
#
# Layout (all little-endian i32):
#   [0] magic  = 0xFAB11BAF
#   [1] version = 1024 (Moonton repack marker, not vanilla 24/27)
#   [2] fileIndex = 1 | 2 | 3   (per-blob: split metadata, one blob per assembly group)
#   [3] headerSize = 252
#   [4..] section table: pairs of (size_i, end_i)
#         section i spans [end_{i-1}, end_{i-1} + size_i)
#         end_{-1} = 252 (= headerSize)
#         i.e. end_i = end_{i-1} + size_i, table is sorted, sections are contiguous
#   tail (after last real section):
#     idx3: ... (26504, 22041700) then (0, 22041700) (0, 25)     -> total 22041700
#     idx1: ... (6376, 4226684)   then (0, 4226684) 6200, 21     -> total 4226684+6200
#     interpretation: last pair end = end of final section; then a zero-size section
#     closing at total; then 2 trailing ints (extra size / small int, meaning TBD)
#
# 28 sections in BOTH blobs -> same section ORDER as vanilla il2cpp v24 header
# (stringLiteral, stringLiteralData, string, events, ... typeDefinitions, images, assemblies)
#
# Transcode to vanilla v24: vanilla_offset_i = section start (= end_{i-1}), size_i unchanged.
#
# Content checks:
#   idx3 sec0 [252, 618476): "@dSpellBackHomeTriggerDis@d..."  (config-key-like strings)
#   idx1 sec0 [252, 56380):  "(UnityUpgradable) -> inputBuffer..." (assembly strings)
#
# CONFIRMED section identification (metahit_2, idx=1, sniff at section starts):
#   #0 stringLiteral        (binary index table, 56128/8 = 7016 literal entries)
#   #1 stringLiteralData    (readable literal constants)
#   #2 string               (starts "mscorlib\0mscorlib.dll\0<Module>")
#   #3..#18                 (tables, TBD exact)
#   #19..#27                (trailing sections match vanilla v24 order:
#                            fieldRefs %12, attributeDataRange %8,
#                            referencedAssemblies %4, unresolvedVCParamTypes %4)
# => SECTION ORDER == vanilla il2cpp v24.x. Moonton only re-encoded the header.
#
# Transcoder recipe:
#   out = b"".join([
#     pack("<ii", 0xFAB11BAF, il2cpp_version_of_vanilla(24.x)),
#     pack("<ii", offset_i, size_i) for each section i in same order
#   ]) + concat(section blobs unchanged)
# Only open question: which vanilla il2cpp version number to emit (24.0/24.1/24.4)
# -> pick via Il2CppTypeDefinition size (88 vs 92) validated against typedef section size.
#
# ============================================================================
# DECODED FROM IDA (liblogic.so, 2026 session) — authoritative:
#
# Real MetadataCache::Initialize = sub_F42C54 (0xf42c54, 0x1f08 bytes)
#   assert tag "il2cpp-MetadataCache::Initialize_start#2036"
#   9 staged phases: sprintf("...InitializeMetadataItem_%d#%d", stage, 9*blob+3001+stage)
#   tail asserts InitializeMetadataItem_0/1/2#2037-2039 (per fileIndex blob)
#   (the 3-alloc fn at 0xf42bd4 = Moonton pool init BEFORE Initialize (#2035): 1x512KB
#    slab pool + 2 intrusive lists -> qword_1B3CAB8/C0/C8)
#
# DISK FILE FORMAT (the -metadata.dat files) = ENCRYPTED WRAPPER:
#   [+0]   0x135BA1DA magic (checked by sub_F1B000 @ 0xf1b000)
#   [+4]   payload length (bytes decrypted, processed in 64B blocks)
#   [+8]   64 ints (256B) = key/nonce table (passed as arg3 to decryptor)
#   [+264] 64 bytes (a1+66) = IV block (arg1 to decryptor)
#   [+328] "CODEPHIL" signature (strncmp 8B) — written AFTER decrypt
#   [+336] REAL metadata header (= our captured FAB11BAF/1024/idx/252 blobs!)
#   decryptor fn = byte_D3E000[720044] = 0xDDED2C (in .text, in-place, 64B blocks:
#                  (src=+264, 64, dst=+8, dstpos, len))
#   file loader = sub_F48CD4 (opens + reads into buffer)
#
# IN-MEMORY HEADER (what we captured) — section addressing:
#   offset_k = ints[3 + 2k]   size_k = ints[4 + 2k]   k = 0..27
#   (ints[3] = 252 = start of section 0)
#
# LOADER-CONFIRMED FIELD MAP (reads in sub_F42C54):
#   int[41] = typeDefinitions offset (k=19)   int[42] = typedefs SIZE  /92 = count
#   int[43] = images offset (k=20)            int[44] = images SIZE    /40 = count
#   int[45] = assemblies offset (k=21)        int[46] = assemblies SIZE >>6 = count (64B)
#   int[14] = methods SIZE (k=5)              /32 = count (32B Il2CppMethodDefinition = v24.0 layout!)
#   +28 into assembly struct = aname (line 527)
#
# VALIDATION (exact integer division = structural proof):
#   blob idx3: typeDefs 2015444/92=21907  images 120/40=3  assemblies 192/64=3  methods 5571104/32=174097
#   blob idx1: typeDefs 500480/92=5440    images 2720/40=68  assemblies 4352/64=68  methods 1165088/32=36409
#
# NOTE: methods=32B (v24.0) but typedefs=92B (v24.1+) — Moonton's layout is MUTATED;
# transcoder must pick the Dumper version per-section, or patch struct sizes.
# Section k index == vanilla v24 pair index for k=19/20/21; k=0/1/2 confirmed by content.
#
#
# TODO: per-section identification via divisibility (typeDefs %92, images %40, assemblies %68),
#       map to Il2CppDumper v24 header field order, write transcoder.

import struct, sys

def sections(b):
    ints = struct.unpack_from("<%di" % (len(b) // 4), b, 0)
    magic, ver, idx, hsz = ints[0] & 0xFFFFFFFF, ints[1], ints[2], ints[3]
    out = []
    prev = hsz
    i = 4
    while i + 1 < len(ints):
        sz, end = ints[i], ints[i + 1]
        if sz == 0:
            break
        out.append((len(out), prev, end, sz))
        prev = end
        i += 2
    return magic, ver, idx, hsz, out, ints[i:i + 8]

if __name__ == "__main__":
    for p in sys.argv[1:]:
        b = open(p, "rb").read()
        magic, ver, idx, hsz, secs, tail = sections(b)
        print(f"== {p.split(chr(92))[-1]} magic={magic:08X} ver={ver} idx={idx} hsz={hsz} total={len(b)}")
        for n, s, e, sz in secs:
            # divisibility hints
            hints = []
            for name, isz in (("typedefs", 92), ("images", 40), ("assemblies", 68), ("methods", 36), ("fields", 12), ("params", 12), ("genericParams", 12)):
                if sz and sz % isz == 0:
                    hints.append(f"{name}:{sz//isz}")
            print(f"  #{n:<2} [{s:>9}, {e:>9}) size={sz:>9} {' '.join(hints)}")
        print("  tail:", tail)

# ============================================================================
# INDEX ENCODING DISCOVERY (dumper test on transcoded idx2, 2026 session):
#
# Moonton encodes cross-section/cross-blob indices as:
#     encoded = (fileIndex << 24) | localIndex      fileIndex = 1|2|3
# Evidence (blob idx2, fieldDefaultValues k=7):
#   fieldIndex  = 0x2000001..0x2000nnn  -> own blob (2), local field ids
#   typeIndex   = 0x10xxxxxx (blob1) / 0x20xxxxxx (blob2) -> CROSS-BLOB refs!
#   dataIndex   = 0x200439a -> blob2 local 17306 < k8 size 17312  EXACT FIT
#
# MERGE PLAN (transcoder v2):
#   1. concat sections across blobs per v24.4 order (k0..k21, then fieldRefs,
#      referencedAssemblies, attributesInfo, attributeTypes, unresolvedVC*)
#   2. rebase every encoded index: global = base[blobId][section] + local
#      (bases = cumulative per-section sizes across blob order)
#   3. typeIndex values point into the BINARY Il2CppType tables (per-blob
#      registrations in libcsharp.so, registered via il2cpp_codegen_register_moba
#      with extra (ii, PKc) args = (blobId, ...)) -> may need binary-side
#      concatenation of the 3 CodeRegistrations for a full dump
#
# TRANSCODED TEST FILES (v1, per-blob, no index decoding yet):
#   moba/meta/global-metadata-1.dat (4226704)
#   moba/meta/global-metadata-2.dat (1326120)
#   moba/meta/global-metadata-3.dat (22041720)
# Dumper v6.7.46 ACCEPTS the header (detects 24.2/24.4), crashes in
# fieldDefaultValuesDic on encoded duplicate keys -> index decoding needed.

# ============================================================================
# BINARY REGISTRATION GROUND TRUTH (frida hooks, 2026-09-10):
#   blob1 = mscorlib: INTERNAL registration (liblogic .data.rel.ro, file off 0x1998b40),
#           NOT via register_moba (loaded by standard MetadataCache::Initialize as
#           "global-metadata.dat" - first loop iteration)
#   blob2 = "-first" (register_moba int1=2), blob3 = "-csharp" (int1=3); int2=3 = blob total
#   Il2CppMetadataRegistration (u32 count + u32 pad + u64 ptr, 16B/pair):
#     blob1: genericClasses 14423, genericInsts 2537, genericMethodTable 24117,
#            TYPES 31564, methodSpecs 26127, fieldOffsets 5440 (=typedef count!), typeDefSizes 5440
#     blob2: gc 8534, gi 1127, gmt 14725, TYPES 13764
#     blob3: gc 128958, gi 22552, gmt 149549, TYPES 196346
#   MERGED TYPE TABLE (concat blob order 1,2,3):
#     blob1 [0,31564) blob2 [31564,45328) blob3 [45328,241674)  total 241674
#   NEXT: dump the 3 types[] arrays live via frida -> synthetic merged binary
#         (or patch registrations) -> Il2CppDumper manual mode -> dump.cs

# ============================================================================
# MERGE v2 COMPLETE (2026-09-10 night):
#   merge.py now decodes ALL encoded indices (encoded blobId<<24|local AND
#   plain-local forms) with ENTRY-UNIT bases + TYPE bases
#   [0,31564,45328] for the binary Il2CppType table.
#   Output: global-metadata-merged.dat (27,593,992 B) — VALIDATED:
#     28908 typedefs, all typeIndex < 241674, names verified:
#     td0 .<Module> / td5441 Microsoft.CodeAnalysis.EmbeddedAttribute /
#     td21907 HttpDownloader.Downloader / td27000 behaviac.WithPrecondition
#   Dumper accepts metadata fully (24.4, all dicts built).
#   REMAINING: binary side for dump.cs — need merged types[]/codegenModules:
#     frida-dump blob1.types (31564*16B from liblogic) + blob2/3 (libcsharp),
#     build synthetic registration or patch -> manual mode -> dump.cs

# ============================================================================
# WORKFLOW NOTE (LO's rule, 2026-09-10):
#   NEVER run `adb shell su -c "cmd1; cmd2"` inline from PowerShell — Windows
#   strips/mangles the quoting and SELinux context handling. ALWAYS:
#     1. write the commands into a .sh file
#     2. adb push it to /data/local/tmp/
#     3. run: adb shell su -c "sh /data/local/tmp/thatscript.sh"

# ============================================================================
# DUMP.CS ACHIEVED (2026-09-10 night, ~21:00):
#   moba/meta/ilregs/dump_raw.cs = 14,278,781 bytes, 336,385 lines,
#   ALL 72 assemblies via RAW il2cpp C API on the LIVE process.
#   Script: moba/frida/dump_raw.js (plain JS, no build!)
#   Method addresses = runtime pointers (module bases of that session recorded
#   in rawdump.log; convert ptr - moduleBase = static RVA).
#   Minor: some classes "<skipped: access violation accessing 0x12e>" (partial).
#
# FRIDA 17 GOTCHAS LEARNED:
#   - NativeFunction multi-arg `.call(...)` = BROKEN ("bad argument count") —
#     call the function DIRECTLY: fn(a, b)
#   - Module.findExportByName = removed; use Module.getExportByName (throws)
#   - ArrayBuffer = NOT accepted as a pointer arg to NativeFunction
#     (write via fwrite(srcPtr, 1, n, fp) directly from mapped memory)
#   - readCString() returns a string (no .readUtf8String() after it!)
#   - frida-il2cpp-bridge: set Il2Cpp.$config.moduleName = "liblogic.so"
#     (it looks for libil2cpp.so = the dormant shim); the lazy getters broke
#     under esbuild bundling -> the raw il2cpp C API dumper = the workaround
#   - il2cpp_param_get_type NOT exported -> ParamInfo.type = @ +0x10
#   - spawn-gating --await attaches AFTER resume; register_moba blobs 2/3
#     catchable at boot, blob1 = internal to liblogic (static .data.rel.ro)
#   - Il2CppMetadataRegistration = u32 count + pad + u64 ptr, 16B/pair

# ============================================================================
# ANTI-CHEAT MAP FROM dump.cs (2026-09-10):
#   BattleReportPlugInType (MTTDProto enum): NotCheck, NotSelect, **Map**,
#     NetWork, **Hurt**, **SkillCD**, Other, ConBattleSamePlayerExp (boosting),
#     WinRateHighExp (sus winrate), BattleDataExp, DataErrorTypeOther
#   -> SERVER-side behavioral fingerprinting; PlugReport {iPlugType @0x10}
#
#   AntiCheatReporter {iMaxSkillCount, iReportStep, currentEntry, trans, bHasRecord}
#   + ReportEntry {SkillID, TryUseDir(Vector3), ProtoDir(Vector3),
#     m_playerPosition(DVector2), m_arrayEnemyPosition(DVector2[])}
#   -> skill-aim sensor: client TryUseDir vs server-sanctioned ProtoDir
#
#   CheatAfkReporter {m_uCheckValue, m_dicRecordPos: Dict<int,ushort>}
#   -> bot/AFK sensor: repeated same-position detection
#
#   AntiPluginData {m_iCheckTime, m_iMinBattleTime, m_sSkillWhiteList,
#     m_lsSCheckData: List<SCheckData{m_iType, m_iPara1..3}>}
#   -> server-pushed check config (drives the Lua Act_PlugCheck!)
#
#   Env sensors: PlugAppInfo{name,package} (app snitching), APKSignature,
#     InPackFileVerify{VerifyResNameSet,bEnableRestart} (resource hash verify),
#     AssetsReport (shader/material tamper tracking)
#   Report channels: Cmd_Act_SocialConfig_GetSocialGFPId_CS, Cmd_GFP_ReportPredict_CS,
#     PlugReport, Cmd_Act_CheatConfig_ReportCheatData_CS{s5MinContentCheck}
#
#   ESP IMPLICATION: all sensors = behavioral (TryUseDir vs ProtoDir, same-pos
#   repetition, CD/hurt stats). READING positions (map hack) touches nothing;
#   ACTING on them (aim assist, auto-skill) trips AntiCheatReporter.
