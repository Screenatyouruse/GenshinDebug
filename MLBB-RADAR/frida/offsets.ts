import "frida-il2cpp-bridge";

Il2Cpp.$config.moduleName = "liblogic.so";

// write target: normal / Secure Folder / Dual Messenger live under different
// Android user ids. Only the package the process actually belongs to is writable,
// so trying the common user ids is enough. First writable wins.
const OUT_CANDIDATES: string[] = (() => {
    const users = ["11", "0", "10", "150", "151", "95", "999"];
    const pkgs = ["com.mobile.legends", "com.mobile.legends.usa"];
    const subs = ["cache", "files"];
    const out: string[] = [];
    for (const u of users) for (const p of pkgs) for (const s of subs) out.push(`/data/user/${u}/${p}/${s}/port.json`);
    return out;
})();

// entity model: field names we resolve per game version (port-friendly)
const WANT: Record<string, string[]> = {
    BattleData: ["m_BattleBridge"],
    BattleBridge: ["bStartBattle"],
    BattleManager: ["Instance", "m_LocalPlayerShow", "m_ShowPlayers", "m_ShowMonsters", "m_dicPlayerShow", "m_dicMonsterShow"],
    ShowEntity: ["m_ID", "m_uGuid", "m_bSameCampType", "m_EntityCampType", "m_bDeath", "canSight", "m_vCachePosition", "m_Hp", "m_HpMax", "m_RoleName", "m_HeroName", "m_HeadIconDefault", "m_bUnityMinimapVisible", "m_OwnSkillComp", "_logicFighter"],
    ShowPlayer: ["m_bInBattle", "m_HeroName", "m_iSummonSkillId"],
    ShowOwnSkillComp: ["m_SkillList", "skillUseTypeList"],
    "Battle.ShowOwnSkillComp": ["m_SkillList", "skillUseTypeList"],
    ShowSkillData: ["m_TranID"],
    "Battle.ShowSkillData": ["m_TranID"],
    "Battle.LogicFighter": ["m_SkillComp"],
    "Battle.LogicSkillComp": ["m_CoolDownComp"],
    "Battle.CoolDownComp": ["m_DicCoolInfo"],
    LogicBattleManager: [],
    // Instance static offset differs per class (LogicBattleManager.Instance is at
    // +0x10, the other managers at +0). m_uiFrameTime = the CD clock.
    "Battle.LogicBattleManager": ["Instance", "m_uiFrameTime", "m_uiRecvNetFrameTime",
        "m_dicPlayerLogic", "m_dicMonsterLogic", "m_LocalPlayerLogic"],
    // cooldown record + the "now" clock, so sk[] survives patches
    "Battle.CoolDownData": ["iSpellID", "uiCoolTime", "originalMaxCdTime", "uiStartTime", "m_isCoolDown"],
    EntityBase: [],
    SmoothFollow: ["__offSetPos", "m_rotation", "m_CameraCurrentPos", "m_MainCamera"],
    GameMethod: [],
    // draft / room-info (Friends.RoomDataManager singleton holds MTTDProto.RoomPlayerInfo dict)
    "Friends.RoomDataManager": ["_instance", "_players"],
    "MTTDProto.RoomPlayerInfo": ["ulUid", "uiSvrId", "strName", "uiNationality", "uiRankLevel", "uiRankLevelBig", "stBase", "sBattleCountry", "bIsOnLine", "bIsReady", "iActCamp", "iRoad", "vWantSelectHero"],
    "MTTDProto.PlayerBaseInfo": ["mHeroMMR", "iPVPVictoryTimes", "iPVPVictoryScore"],
    ShowBattleCamera: ["Instance", "m_CamPos", "m_CamRot", "m_iFieldOfView", "m_cameraDepth"],
    // draft roster bootstrap for the EXTERNAL heap scan: ally list gives us a
    // live RoomData, its object header gives us the RoomData klass pointer,
    // then cppport scans the GC region for camp-2 siblings.
    ChooseHeroMgr: ["Instance", "m_SelfCampHeroInfoList"],
    "SystemData.RoomData": ["lUid", "iCamp", "iPos", "_sName", "bRobot", "heroid", "heroskin",
        "headID", "uiSex", "country", "uiRankLevel", "iRoad", "banHero", "uiHeroIDChoose",
        "vWantSelectHero"],
};

Il2Cpp.perform(() => {
    const ac = Il2Cpp.domain.assembly("Assembly-CSharp.dll").image;

    const out: any = {
        generated: new Date().toISOString(),
        package: "com.mobile.legends.usa",
        note: "offsets are relative: statics -> staticFieldsData block; instance -> object + 0x10 header",
        il2cpp: { objectHeader: 0x10, arrayDataOffset: 0x20, stringLength: 0x10, stringChars: 0x14 },
        list: { items: 0x10, size: 0x18 },
        dictionary: { entries: 0x18, count: 0x20, entryKey: 0x18, entryValue: 0x20, entryStride: 0x18 },
        classes: {},
    };

    const findClass = (fn: string) => {
        for (const kk of ac.classes) if (kk.fullName === fn || kk.name === fn) return kk;
        return null;
    };
    for (const clsName of Object.keys(WANT)) {
        const shortName: string = clsName.includes(".") ? (clsName.split(".").pop() as string) : clsName;
        const k = findClass(clsName) || findClass(shortName);
        if (!k) { out.classes[clsName] = { error: "not found" }; continue; }
        const c: any = { fields: {}, statics: {} };
        try { c.staticFieldsData = k.staticFieldsData.toString(); } catch (e: any) { c.staticFieldsDataError = String(e); }
        for (const f of k.fields) {
            if (WANT[clsName].indexOf(f.name) === -1) continue;
            const entry: any = { offset: f.offset, type: f.type.name, isStatic: f.isStatic };
            if (f.isStatic && c.staticFieldsData) {
                try { entry.runtimeAddr = k.staticFieldsData.add(f.offset).toString(); } catch (e) { /* noop */ }
            }
            if (f.isStatic) c.statics[f.name] = entry; else c.fields[f.name] = entry;
        }
        // for resilient statics: klass pointer + static block offset (statics can be reallocated)
        try {
            c.klassHandle = k.handle.toString();
            const diff = k.staticFieldsData.sub(k.handle);
            c.klassStaticOff = diff.toString(); // uint64 hex-ish string; do NOT toInt32 (huge gap)
        } catch (e: any) { c.klassErr = String(e); }
        out.classes[clsName] = c;
    }

    // container layouts resolved from corlib (never hardcode il2cpp layouts)
    try {
        const corlib = Il2Cpp.corlib;
        const dct = corlib.class("Dictionary`2");
        const lst = corlib.class("List`1");
        const arr = corlib.class("Array");
        out.dictionary = {};
        for (const f of dct.fields) if (["buckets", "_buckets", "entries", "_entries", "count", "_count", "version", "_version", "freeList", "_freeList"].indexOf(f.name) !== -1) out.dictionary[f.name] = f.offset;
        out.list = {};
        for (const f of lst.fields) if (["_items", "items", "_size", "size", "_version", "version"].indexOf(f.name) !== -1) out.list[f.name] = f.offset;
        out.array = { maxLength: 0x18, data: 0x20 };
        try { for (const f of arr.fields) if (f.name === "max_length") out.array.maxLength = f.offset; } catch (e) { /* fixed layout */ }
        out.string = { length: 0x10, chars: 0x14 };
    } catch (e: any) {
        out.containerError = String(e);
    }

    // Il2CppClass.static_fields offset. It is engine-version dependent (was 0xB8,
    // this build is 0xA8) and every klass->statics->instance path depends on it.
    // Derive it: whichever struct slot holds the class's staticFieldsData pointer.
    try {
        for (const clsName of ["BattleManager", "ChooseHeroMgr", "BattleData", "Friends.RoomDataManager"]) {
            const c = out.classes[clsName];
            if (!c || !c.klassHandle || !c.staticFieldsData) continue;
            const kh = ptr(String(c.klassHandle));
            const sfd = ptr(String(c.staticFieldsData));
            let found = 0;
            for (let off = 0; off < 0x200; off += 8) {
                try { if (kh.add(off).readPointer().equals(sfd)) { found = off; break; } } catch (e) { /* gap */ }
            }
            if (found) {
                out.il2cpp.staticFieldsOff = found;
                out.il2cpp.staticFieldsFrom = clsName;
                break;
            }
        }
    } catch (e: any) { out.sfOffError = String(e); }

    // metadata usage slots: scan libcsharp's OWN writable mappings instead of a
    // hardcoded base+0x7500000/2MB window. The fixed window breaks whenever the
    // module is rebuilt (a patch moves the usage table), which is exactly what
    // killed every slot.* after the last update. Exact 8-byte klass match, 2/class.
    try {
        const mod = Process.findModuleByName("libcsharp.so");
        if (mod) {
            out.slots = {};
            const wanted: Array<{ name: string; kh: NativePointer; pat: string; hits: any[] }> = [];
            for (const clsName of ["BattleManager", "LogicBattleManager", "BattleData", "SmoothFollow", "GameMethod", "RoomDataManager", "ChooseHeroMgr"]) {
                const k = out.classes[clsName];
                if (!k || !k.klassHandle) continue;
                try {
                    const kh = ptr(String(k.klassHandle));
                    // little-endian byte pattern of the (possibly MTE-tagged) handle
                    const hex = kh.toString(16).replace(/^0x/, "").padStart(16, "0").slice(-16);
                    const bytes: number[] = [];
                    for (let i = 7; i >= 0; i--) bytes.push(parseInt(hex.substr(i * 2, 2), 16));
                    const pat = bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
                    wanted.push({ name: clsName, kh, pat, hits: [] });
                } catch (e) {}
            }

            // readable data ranges inside the libcsharp image. Must include r-- :
            // il2cpp metadata-usage tables live in .data.rel.ro, which RELRO makes
            // read-only after relocation (the old rw-only filter missed them).
            const loN = parseInt(mod.base.toString(), 16);
            const hiN = loN + mod.size;
            const ranges: MemoryRange[] = [];
            const seen = new Set<string>();
            for (const prot of ["rw-", "r--"]) {
                let rs: MemoryRange[] = [];
                try { rs = Process.enumerateRanges(prot as any); } catch (e) { rs = []; }
                for (const r of rs) {
                    const b = parseInt(r.base.toString(), 16);
                    const key = r.base.toString() + ":" + r.size;
                    // start inside the image (allow end past hiN: .bss can round past size)
                    if (b >= loN && b < hiN && !seen.has(key)) { seen.add(key); ranges.push(r); }
                }
            }
            out.slotScan = {
                module: mod.name,
                moduleSize: mod.size,
                ranges: ranges.map((r) => ({ base: r.base.toString(), size: r.size })),
            };

            for (const w of wanted) {
                for (const r of ranges) {
                    if (w.hits.length >= 2) break;
                    let hits: any[] = [];
                    try { hits = Memory.scanSync(r.base, r.size, w.pat); } catch (e) {}
                    for (const h of hits) {
                        if (w.hits.length >= 2) break;
                        w.hits.push({
                            rva: "0x" + h.address.sub(mod.base).toString(16),
                            addr: h.address.toString(),
                        });
                    }
                }
            }
            for (const w of wanted) (out.slots as any)[w.name] = w.hits;
        }
    } catch (e: any) { out.slotsError = String(e); }

    // build fingerprint: lets serve.py detect a stale port.json for a different
    // build (normal vs Secure Folder vs Dual Messenger can be on different builds).
    try {
        out.build = {};
        for (const name of ["libcsharp.so", "liblogic.so"]) {
            const m = Process.findModuleByName(name);
            if (!m) continue;
            let hash = 0x811c9dc5;
            try {
                const b = new Uint8Array(m.base.readByteArray(0x1000) as ArrayBuffer);
                for (let i = 0; i < b.length; i++) { hash ^= b[i]; hash = (hash * 0x01000193) >>> 0; }
            } catch (e) { hash = 0; }
            (out.build as any)[name] = {
                size: m.size,
                base: m.base.toString(),
                head: ("00000000" + hash.toString(16)).slice(-8),
            };
        }
    } catch (e: any) { out.buildError = String(e); }

    // spell tracker extras. These MUST be resolved from metadata, not hardcoded:
    // the old static values (nowOffset 412 / cdA 20 / cdB 28 / fighterCache 968)
    // went stale on a patch and made every cooldown read -1 (now == 0).
    out.timer = { klassSlot: "0x760B960", nowOffset: 412, cdA: 20, cdB: 28, fighterCache: 968 };
    try {
        const lbm = out.classes["Battle.LogicBattleManager"] || out.classes["LogicBattleManager"];
        if (lbm && lbm.fields && lbm.fields["m_uiFrameTime"]) out.timer.nowOffset = lbm.fields["m_uiFrameTime"].offset;
        const cdd = out.classes["Battle.CoolDownData"];
        if (cdd && cdd.fields) {
            if (cdd.fields["uiCoolTime"]) out.timer.cdA = cdd.fields["uiCoolTime"].offset;
            if (cdd.fields["uiStartTime"]) out.timer.cdB = cdd.fields["uiStartTime"].offset;
        }
        const se = out.classes["ShowEntity"];
        if (se && se.fields) {
            for (const fname of Object.keys(se.fields)) {
                if (/LogicFighter/i.test(se.fields[fname].type)) { out.timer.fighterCache = se.fields[fname].offset; break; }
            }
        }
    } catch (e: any) { out.timerError = String(e); }

    // world-to-minimap constants come from themaphack; verify current world scale by sampling later
    out.minimap = { camp1AngleDeg: 134.76, camp2AngleDeg: 314.60, worldScale: 74.11 };

    // box-ESP camera path: SmoothFollow instance via GameMethod holder slot.
    // holderSlot (GameMethod klass usage) -> klass+0xB8 -> statics -> +holderStatic -> SmoothFollow inst
    // -> +sfOffset (__offSetPos): camPos = playerPos - offset; +rotOffset (m_rotation quat) -> view matrix.
    try {
        out.cam = {};
        const mod2 = Process.findModuleByName("libcsharp.so");
        const gk = out.classes["GameMethod"], sfk = out.classes["SmoothFollow"];
        const gHits = (out.slots && out.slots["GameMethod"]) || [];
        if (mod2 && gk && gk.klassHandle && sfk && sfk.klassHandle && gHits.length) {
            const slotRva = parseInt(gHits[0].rva);
            const gklass = mod2.base.add(slotRva).readPointer();
            const statics = gklass.add(0xB8).readPointer();
            const sfHandle = ptr(String(sfk.klassHandle));
            for (let so = 0; so < 0x100; so += 8) {
                try {
                    const cand = statics.add(so).readPointer();
                    if (cand.isNull()) continue;
                    if (cand.readPointer().equals(sfHandle)) {
                        (out.cam as any).holderSlot = gHits[0].rva;
                        (out.cam as any).holderStatic = so;
                        break;
                    }
                } catch (e) {}
            }
        }
    } catch (e: any) { out.camError = String(e); }

    // probe writes: only the package this process belongs to is writable.
    // derive `package` from the winning path (so we stop mislabelling .usa).
    let written = "";
    for (const p of OUT_CANDIDATES) {
        try { const f = new File(p, "w"); f.write(""); f.flush(); f.close(); written = p; break; } catch (e) { /* next */ }
    }
    if (written) {
        const m = written.match(/\/data\/user\/\d+\/([^/]+)\//);
        if (m) out.package = m[1];
    }

    const s = JSON.stringify(out, null, 1);
    if (written) {
        try { const f = new File(written, "w"); f.write(s); f.flush(); f.close(); } catch (e) { written = ""; }
    }
    console.log("port.json -> " + (written || "NOWHERE (permission denied on all candidates)"));
    console.log(s);
});
