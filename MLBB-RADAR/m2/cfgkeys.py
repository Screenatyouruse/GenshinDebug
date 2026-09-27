"""m2 — THE config generator. port.json -> cppport key=value stream.

serve.py, tools.py and port2config.py all call emit(); never build config anywhere else.
"""
import json


def _classes(port):
    return port.get("classes", {})


def emit(port: dict) -> str:
    cl = _classes(port)
    slots = port.get("slots") or {}
    lines = []

    def st(cls, field):
        e = (cl.get(cls, {}).get("statics") or {}).get(field)
        if not e:
            return
        if e.get("runtimeAddr"):
            lines.append(f"static.{cls}.{field}=0x{int(e['runtimeAddr'], 16):x}")
        elif cl.get(cls, {}).get("staticFieldsData"):
            lines.append(f"static.{cls}.{field}=0x{int(cl[cls]['staticFieldsData'], 16) + e['offset']:x}")

    def ins(cls, field, prefix="inst"):
        """prefix.Class.field — for keys like inst.BattleManager.m_ShowPlayers."""
        f = (cl.get(cls, {}).get("fields") or {}).get(field)
        if f:
            lines.append(f"{prefix}.{cls}.{field}={f['offset']}")

    def mk(prefix, cls, field):
        """prefix.field — for keys like lf.m_SkillComp (class name is NOT in the key)."""
        f = (cl.get(cls, {}).get("fields") or {}).get(field)
        if f:
            lines.append(f"{prefix}.{field}={f['offset']}")

    def ent(field):
        f = (cl.get("ShowEntity", {}).get("fields") or {}).get(field)
        if f:
            lines.append(f"ent.{field}={f['offset']}")

    # LogicFighter registry dicts (guid -> LogicFighter); these moved, and a stale
    # offset means the CD path silently falls back to a fighter with no cool-down comp
    lbmf = (cl.get("Battle.LogicBattleManager") or cl.get("LogicBattleManager") or {}).get("fields", {})
    for key, fname in (("lbm.playerLogic", "m_dicPlayerLogic"),
                       ("lbm.monsterLogic", "m_dicMonsterLogic")):
        if fname in lbmf:
            lines.append(f"{key}={lbmf[fname]['offset']}")

    # singleton "Instance" static offset per manager (LogicBattleManager is not 0)
    for alias, cls in (("BattleManager", "BattleManager"),
                       ("LogicBattleManager", "Battle.LogicBattleManager"),
                       ("ChooseHeroMgr", "ChooseHeroMgr")):
        e = ((cl.get(cls, {}).get("statics") or {}).get("Instance")) or {}
        if "offset" in e:
            lines.append(f"instoff.{alias}={e['offset']}")

    # il2cpp struct constants (engine-version dependent)
    il2cpp = port.get("il2cpp") or {}
    if il2cpp.get("staticFieldsOff") is not None:
        lines.append("il2cpp.sfOff=0x%x" % int(il2cpp["staticFieldsOff"]))

    # battle core
    st("BattleData", "m_BattleBridge")
    st("BattleManager", "Instance")
    ins("BattleManager", "m_LocalPlayerShow")
    ins("BattleManager", "m_ShowPlayers")
    ins("BattleManager", "m_ShowMonsters")
    ins("BattleManager", "m_dicMonsterShow")
    ins("BattleManager", "m_dicPlayerShow")
    ins("BattleManager", "m_MainTowerDead")
    for f in ("m_uGuid", "m_ID", "m_EntityCampType", "m_bDeath", "m_bSameCampType",
              "canSight", "m_vCachePosition", "m_Hp", "m_HpMax", "m_RoleName", "m_OwnSkillComp",
              "_MoveDir", "m_dMoveSpeed", "m_iGrassId", "_iSkillInvisibility", "m_Level",
              "m_Mp", "_MpMax", "CurrentAnimName"):
        ent(f)
    mk("ent", "ShowPlayer", "m_iSummonSkillId")
    mk("own", "ShowOwnSkillComp", "m_SkillList")
    mk("sd", "ShowSkillData", "m_TranID")
    mk("lf", "Battle.LogicFighter", "m_SkillComp")
    mk("lsc", "Battle.LogicSkillComp", "m_CoolDownComp")
    mk("cdc", "Battle.CoolDownComp", "m_DicCoolInfo")
    mk("sp", "ShowPlayer", "m_HeroName")
    mk("sp", "ShowPlayer", "m_bInBattle")
    mk("sp", "ShowPlayer", "_iTotalGold")

    lbm = cl.get("Battle.LogicBattleManager") or cl.get("LogicBattleManager") or {}
    if lbm.get("klassHandle"):
        lines.append("klass.LogicBattleManager=0x%x" % (int(lbm["klassHandle"], 16) & 0x00FFFFFFFFFFFFFF))
    else:
        lines.append("klass.LogicBattleManager=")
    lines.append("ent.fighterCache=%d" % (port.get("timer") or {}).get("fighterCache", 968))

    def slot_rva(name, default):
        v = slots.get(name, default)
        if isinstance(v, list):
            v = v[0]["rva"] if v else default
        if isinstance(v, str):
            v = int(v, 16)
        return v

    lines.append("slot.BattleManager=0x%x" % slot_rva("BattleManager", 0x7646060))
    lines.append("slot.LogicBattleManager=0x%x" % slot_rva("LogicBattleManager", 0x7684B38))
    if slots.get("ChooseHeroMgr"):
        lines.append("slot.ChooseHeroMgr=0x%x" % slot_rva("ChooseHeroMgr", 0))

    t = port.get("timer") or {}
    for k, src in (("timer.klassSlot", "klassSlot"), ("timer.nowOff", "nowOffset"),
                   ("timer.cdA", "cdA"), ("timer.cdB", "cdB")):
        if src in t:
            lines.append(f"{k}={t[src]}")

    # party/room (Friends.RoomDataManager) — optional
    rdm = cl.get("Friends.RoomDataManager", {})
    e = (rdm.get("statics") or {}).get("_instance") or {}
    if e.get("runtimeAddr"):
        lines.append("static.RoomDataManager._instance=0x%x" % int(e["runtimeAddr"], 16))
    rpi = cl.get("MTTDProto.RoomPlayerInfo", {}).get("fields", {})
    for key, fname in (("rpi.uid", "ulUid"), ("rpi.svr", "uiSvrId"), ("rpi.name", "strName"),
                       ("rpi.nation", "uiNationality"), ("rpi.rank", "uiRankLevel"),
                       ("rpi.rankBig", "uiRankLevelBig"), ("rpi.base", "stBase"),
                       ("rpi.country", "sBattleCountry"), ("rpi.online", "bIsOnLine"),
                       ("rpi.ready", "bIsReady"), ("rpi.camp", "iActCamp"),
                       ("rpi.road", "iRoad"), ("rpi.want", "vWantSelectHero")):
        if fname in rpi:
            lines.append(f"{key}={rpi[fname]['offset']}")
    pbi = cl.get("MTTDProto.PlayerBaseInfo", {}).get("fields", {})
    for key, fname in (("pbi.heroMMR", "mHeroMMR"), ("pbi.vTimes", "iPVPVictoryTimes"),
                       ("pbi.vScore", "iPVPVictoryScore")):
        if fname in pbi:
            lines.append(f"{key}={pbi[fname]['offset']}")
    lines.append("rd.players=%d" % (rdm.get("fields", {}).get("_players", {}).get("offset", 16)))

    # draft roster (fridaless: slot -> ChooseHeroMgr -> ally list -> klass -> heap scan)
    chm = cl.get("ChooseHeroMgr") or {}
    inst = (chm.get("statics") or {}).get("Instance") or {}
    if inst.get("runtimeAddr"):
        lines.append("static.ChooseHeroMgr.Instance=0x%x" % int(inst["runtimeAddr"], 16))
    if (chm.get("fields") or {}).get("m_SelfCampHeroInfoList"):
        lines.append("ch.selfList=%d" % chm["fields"]["m_SelfCampHeroInfoList"]["offset"])
    room = (cl.get("SystemData.RoomData") or cl.get("RoomData") or {}).get("fields", {})
    for key, fname in (("rd.uid", "lUid"), ("rd.camp", "iCamp"), ("rd.pos", "iPos"),
                       ("rd.name", "_sName"), ("rd.robot", "bRobot"), ("rd.heroid", "heroid"),
                       ("rd.skin", "heroskin"), ("rd.country", "country"),
                       ("rd.rank", "uiRankLevel"), ("rd.road", "iRoad"),
                       ("rd.want", "vWantSelectHero"),
                       ("rd.ban", "banHero"), ("rd.choose", "uiHeroIDChoose")):
        if fname in room:
            lines.append(f"{key}={room[fname]['offset']}")

    return "\n".join(lines) + "\n"


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def health(port: dict) -> list:
    """Human-readable warnings about a resolved port.json (stale / degraded)."""
    warns = []
    slots = port.get("slots") or {}
    if slots and not any(slots.get(k) for k in slots):
        warns.append("all slots empty -> offsets stale for this build (run 'moba refresh')")
    if not port.get("build"):
        warns.append("no build fingerprint in port.json (regenerate with updated offsets.ts)")
    for cls, c in (port.get("classes") or {}).items():
        if isinstance(c, dict) and c.get("error") == "not found":
            warns.append(f"class not found: {cls}")
    if not slots:
        warns.append("no slots section at all")
    return warns


def build_id(port: dict) -> str:
    b = port.get("build") or {}
    cs = b.get("libcsharp.so") or {}
    ll = b.get("liblogic.so") or {}
    if not cs and not ll:
        return "(none)"
    return f"csharp {cs.get('size', '?')}/{cs.get('head', '?')} logic {ll.get('size', '?')}/{ll.get('head', '?')}"


# selftest: keys the reader/overlay need to function at all
REQUIRED = [
    "slot.BattleManager",
    "rd.players",
]
# nice-to-have (warn, not fail)
RECOMMENDED = [
    "slot.ChooseHeroMgr",
    "ch.selfList",
    "rd.uid",
    "rd.camp",
    "rd.name",
    "static.ChooseHeroMgr.Instance",
]
