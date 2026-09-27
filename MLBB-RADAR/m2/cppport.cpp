// moba_reader.cpp â€” optimized external MLBB entity reader (C++20)
#include <iostream>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <linux/prctl.h>
#include <fstream>
#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>
#include <chrono>
#include <ctime>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <thread>
#include <cerrno>
#include <algorithm>
#include <sched.h>
#include <sys/uio.h>
#include <signal.h>
#include <cstdio>
#include <cstdlib>

namespace Constants {
    constexpr size_t OBJ_HEADER    = 0x10;
    constexpr size_t ARR_LEN       = 0x10;
    constexpr size_t ARR_DATA      = 0x20;
    constexpr size_t LIST_ITEMS    = 0x10;
    constexpr size_t LIST_SIZE     = 0x18;
    constexpr size_t DICT_ENTRIES  = 0x18;
    constexpr size_t DICT_COUNT    = 0x20;
    constexpr size_t DICT_STRIDE   = 0x18;
    constexpr size_t DICT_VALUE    = 0x10;
    constexpr size_t IL2CPP_SF_OFF = 0xB8;
    constexpr size_t STR_LEN       = 0x10;
    constexpr size_t STR_CHARS     = 0x14;
    constexpr size_t MAP_MAX       = 1024;
    constexpr size_t ENTITY_SLICE  = 0xB00; // must cover furthest field (_iTotalGold@2556+4)
    constexpr size_t DRAFT_SLICE   = 0x240; // covers furthest RoomData field (vWantSelectHero@0x228+8)
}

struct Config {
    uint64_t st_battlebridge = 0;
    uint64_t st_bm_instance = 0;
    uint64_t klass_bm = 0;
    uint64_t klass_lbm = 0;
    int32_t  klass_bm_staticoff = 0;
    int32_t  bm_local = -1, bm_players = -1, bm_monsters = -1, bm_dicmonsters = -1, bm_dicplayers = -1;
    int32_t  bm_maintowerdead = 128;
    int32_t  e_guid = -1, e_id = -1, e_camp = -1, e_death = -1, e_samecamp = -1, e_cansight = -1;
    int32_t  e_pos = -1, e_hp = -1, e_hpmax = -1, e_name = -1;
    int32_t  e_movedir = -1, e_movespeed = -1, e_grass = -1, e_invis = -1, e_lvl = -1;
    int32_t  e_mp = -1, e_mpmax = -1, e_anim = -1;
    int32_t  sp_inbattle = -1, sp_gold = -1;
    int32_t  e_ownskill = -1, e_summonid = -1;
    int32_t  own_skilllist = -1, sd_tranid = -1, lf_skillcomp = -1, lsc_coolcomp = -1, cdc_diccool = -1;
    int32_t  fighter_cache = 968;
    int32_t  sp_heroname = -1;
    int32_t  now_off = 0, cd_a = 0, cd_b = 0;
    uint64_t timer_klass_slot = 0;
    // Il2CppClass.static_fields offset — engine-version dependent (was 0xB8, now 0xA8).
    // Derived at refresh into the config; default keeps older builds working.
    int32_t  sf_off = 0xB8;
    // "Instance" static-field offset per manager (LogicBattleManager.Instance is +0x10,
    // BattleManager/ChooseHeroMgr are +0). Resolved at refresh.
    int32_t  bmi_off = 0, lbmi_off = 0, chi_off = 0;
    // LogicFighter registry dicts on LogicBattleManager (moved 168/176 -> 72/80)
    int32_t  lbm_player_off = 168, lbm_monster_off = 176;
    uint64_t slot_bm = 0;
    uint64_t slot_lbm = 0;
    // draft / room-hack: Friends.RoomDataManager singleton + MTTDProto.RoomPlayerInfo layout
    uint64_t slot_room = 0;   // fallback: libcsharp offset of RoomDataManager's usage slot
    uint64_t st_room_instance = 0;  // preferred: RoomDataManager._instance runtime addr (per-session)
    int32_t  rd_players = 0x10;              // RoomDataManager._players (Dict<ulong, RoomPlayerInfo>)
    int32_t  rpi_uid = 0x10, rpi_svr = 0x18, rpi_name = 0x20, rpi_nation = 0x30;
    int32_t  rpi_rank = 0x34, rpi_rankbig = 0x38, rpi_base = 0x48, rpi_country = 0x78;
    int32_t  rpi_online = 0x90, rpi_ready = 0x91, rpi_camp = 0xa0, rpi_road = 0xfc;
    int32_t  rpi_want = 0x130;               // List<uint32> wanted heroes
    int32_t  pbi_herommr = 0x88;             // PlayerBaseInfo.mHeroMMR (heroId->MMR, the favs)
    int32_t  pbi_vtimes = 0x84;              // PlayerBaseInfo.iPVPVictoryTimes
    int32_t  pbi_vscore = 0x80;              // PlayerBaseInfo.iPVPVictoryScore
    int32_t  room_favtop = 3;                // how many favourite heroes to emit

    // ---- draft roster (external heap scan; no frida at match time) ----
    uint64_t st_choose = 0;                  // ChooseHeroMgr.Instance static runtime addr
    uint64_t slot_choose = 0;                // libcsharp RVA of ChooseHeroMgr usage slot (session-stable)
    int32_t  ch_self_list = -1;              // ChooseHeroMgr.m_SelfCampHeroInfoList
    int32_t  d_uid = 0x20, d_camp = 0x30, d_pos = 0x34, d_name = 0x40, d_robot = 0x48;
    int32_t  d_heroid = 0x4c, d_skin = 0x50, d_country = 0x5c, d_rank = 0x128, d_road = 0x140;
    int32_t  d_want = 0x228;                 // RoomData.vWantSelectHero (List<uint> preselected heroes)

    bool loadFromStream(std::istream& is) {
        std::string line;
        while (std::getline(is, line)) {
            auto eq = line.find('=');
            if (eq == std::string::npos) continue;
            std::string key = line.substr(0, eq);
            uint64_t val = std::strtoull(line.substr(eq + 1).c_str(), nullptr, 0);

            if (key == "static.BattleManager.Instance") st_bm_instance = val;
            else if (key == "static.BattleData.m_BattleBridge") st_battlebridge = val;
            else if (key == "klass.BattleManager") klass_bm = val;
            else if (key == "klass.LogicBattleManager") klass_lbm = val;
            else if (key == "slot.BattleManager") slot_bm = val;
            else if (key == "slot.LogicBattleManager") slot_lbm = val;
            else if (key == "slot.ChooseHeroMgr") slot_choose = val;
            else if (key == "slot.RoomDataManager") slot_room = val;
            else if (key == "static.RoomDataManager._instance") st_room_instance = val;
            else if (key == "klass.BattleManager.staticOff") klass_bm_staticoff = static_cast<int32_t>(val);
            else if (key == "ent.m_OwnSkillComp") e_ownskill = static_cast<int32_t>(val);
            else if (key == "ent.m_iSummonSkillId") e_summonid = static_cast<int32_t>(val);
            else if (key == "own.m_SkillList") own_skilllist = static_cast<int32_t>(val);
            else if (key == "sd.m_TranID") sd_tranid = static_cast<int32_t>(val);
            else if (key == "lf.m_SkillComp") lf_skillcomp = static_cast<int32_t>(val);
            else if (key == "lsc.m_CoolDownComp") lsc_coolcomp = static_cast<int32_t>(val);
            else if (key == "cdc.m_DicCoolInfo") cdc_diccool = static_cast<int32_t>(val);
            else if (key == "timer.klassSlot") timer_klass_slot = val;
            else if (key == "il2cpp.sfOff") sf_off = static_cast<int32_t>(val);
            else if (key == "instoff.BattleManager") bmi_off = static_cast<int32_t>(val);
            else if (key == "instoff.LogicBattleManager") lbmi_off = static_cast<int32_t>(val);
            else if (key == "instoff.ChooseHeroMgr") chi_off = static_cast<int32_t>(val);
            else if (key == "lbm.playerLogic") lbm_player_off = static_cast<int32_t>(val);
            else if (key == "lbm.monsterLogic") lbm_monster_off = static_cast<int32_t>(val);
            else if (key == "room.favTop") room_favtop = static_cast<int32_t>(val);
            else if (key == "rd.players") rd_players = static_cast<int32_t>(val);
            else if (key == "static.ChooseHeroMgr.Instance") st_choose = val;
            else if (key == "ch.selfList") ch_self_list = static_cast<int32_t>(val);
            else if (key == "rd.uid") d_uid = static_cast<int32_t>(val);
            else if (key == "rd.camp") d_camp = static_cast<int32_t>(val);
            else if (key == "rd.pos") d_pos = static_cast<int32_t>(val);
            else if (key == "rd.name") d_name = static_cast<int32_t>(val);
            else if (key == "rd.robot") d_robot = static_cast<int32_t>(val);
            else if (key == "rd.heroid") d_heroid = static_cast<int32_t>(val);
            else if (key == "rd.skin") d_skin = static_cast<int32_t>(val);
            else if (key == "rd.country") d_country = static_cast<int32_t>(val);
            else if (key == "rd.rank") d_rank = static_cast<int32_t>(val);
            else if (key == "rd.road") d_road = static_cast<int32_t>(val);
            else if (key == "rd.want") d_want = static_cast<int32_t>(val);
            else if (key == "rpi.uid") rpi_uid = static_cast<int32_t>(val);
            else if (key == "rpi.svr") rpi_svr = static_cast<int32_t>(val);
            else if (key == "rpi.name") rpi_name = static_cast<int32_t>(val);
            else if (key == "rpi.nation") rpi_nation = static_cast<int32_t>(val);
            else if (key == "rpi.rank") rpi_rank = static_cast<int32_t>(val);
            else if (key == "rpi.rankBig") rpi_rankbig = static_cast<int32_t>(val);
            else if (key == "rpi.base") rpi_base = static_cast<int32_t>(val);
            else if (key == "rpi.country") rpi_country = static_cast<int32_t>(val);
            else if (key == "rpi.online") rpi_online = static_cast<int32_t>(val);
            else if (key == "rpi.ready") rpi_ready = static_cast<int32_t>(val);
            else if (key == "rpi.camp") rpi_camp = static_cast<int32_t>(val);
            else if (key == "rpi.road") rpi_road = static_cast<int32_t>(val);
            else if (key == "rpi.want") rpi_want = static_cast<int32_t>(val);
            else if (key == "pbi.heroMMR") pbi_herommr = static_cast<int32_t>(val);
            else if (key == "pbi.vTimes") pbi_vtimes = static_cast<int32_t>(val);
            else if (key == "pbi.vScore") pbi_vscore = static_cast<int32_t>(val);
            else if (key == "timer.nowOff") now_off = static_cast<int32_t>(val);
            else if (key == "timer.cdA") cd_a = static_cast<int32_t>(val);
            else if (key == "timer.cdB") cd_b = static_cast<int32_t>(val);
            else if (key == "ent.fighterCache") fighter_cache = static_cast<int32_t>(val);
            else if (key == "sp.m_HeroName") sp_heroname = static_cast<int32_t>(val);
            else if (key == "inst.BattleManager.m_LocalPlayerShow") bm_local = static_cast<int32_t>(val);
            else if (key == "inst.BattleManager.m_ShowPlayers") bm_players = static_cast<int32_t>(val);
            else if (key == "inst.BattleManager.m_ShowMonsters") bm_monsters = static_cast<int32_t>(val);
            else if (key == "inst.BattleManager.m_dicMonsterShow") bm_dicmonsters = static_cast<int32_t>(val);
            else if (key == "inst.BattleManager.m_dicPlayerShow") bm_dicplayers = static_cast<int32_t>(val);
            else if (key == "inst.BattleManager.m_MainTowerDead") bm_maintowerdead = static_cast<int32_t>(val);
            else if (key == "ent.m_uGuid") e_guid = static_cast<int32_t>(val);
            else if (key == "ent.m_ID") e_id = static_cast<int32_t>(val);
            else if (key == "ent.m_EntityCampType") e_camp = static_cast<int32_t>(val);
            else if (key == "ent.m_bDeath") e_death = static_cast<int32_t>(val);
            else if (key == "ent.m_bSameCampType") e_samecamp = static_cast<int32_t>(val);
            else if (key == "ent.canSight") e_cansight = static_cast<int32_t>(val);
            else if (key == "ent.m_vCachePosition") e_pos = static_cast<int32_t>(val);
            else if (key == "ent.m_Hp") e_hp = static_cast<int32_t>(val);
            else if (key == "ent.m_HpMax") e_hpmax = static_cast<int32_t>(val);
            else if (key == "ent.m_RoleName") e_name = static_cast<int32_t>(val);
            else if (key == "ent._MoveDir") e_movedir = static_cast<int32_t>(val);
            else if (key == "ent.m_dMoveSpeed") e_movespeed = static_cast<int32_t>(val);
            else if (key == "ent.m_iGrassId") e_grass = static_cast<int32_t>(val);
            else if (key == "ent._iSkillInvisibility") e_invis = static_cast<int32_t>(val);
            else if (key == "ent.m_Level") e_lvl = static_cast<int32_t>(val);
            else if (key == "ent.m_Mp") e_mp = static_cast<int32_t>(val);
            else if (key == "ent._MpMax") e_mpmax = static_cast<int32_t>(val);
            else if (key == "ent.CurrentAnimName") e_anim = static_cast<int32_t>(val);
            else if (key == "sp.m_bInBattle") sp_inbattle = static_cast<int32_t>(val);
            else if (key == "sp._iTotalGold") sp_gold = static_cast<int32_t>(val);
        }
        // usable if ANY anchor exists (battle via static/slot, or draft via slot/static,
        // or room via slot/static). A bm-only gate wrongly rejects slot-only configs.
        return st_bm_instance != 0 || slot_bm != 0 || st_battlebridge != 0 ||
               st_choose != 0 || slot_choose != 0 ||
               st_room_instance != 0 || slot_room != 0;
    }

    bool load(const std::string& path) {
        std::ifstream file(path);
        return file.is_open() && loadFromStream(file);
    }
};

static inline bool isProcessAlive(pid_t pid) {
    return kill(pid, 0) == 0;
}

class ProcessMemory {
    pid_t pid = -1;
    mutable int memFd = -1;

    int fd() const {
        if (memFd < 0) {
            char p[64];
            snprintf(p, sizeof(p), "/proc/%d/mem", (int)pid);
            memFd = open(p, O_RDONLY);
        }
        return memFd;
    }

public:
    explicit ProcessMemory(int target_pid) : pid(target_pid) {}

    bool isValid() const { return pid > 0; }

    inline bool readRaw(uint64_t addr, void* buf, size_t len) const {
        if (addr < 0x1000 || addr > 0x7fffffffffffULL) return false;
        struct iovec local = { buf, len };
        struct iovec remote = { reinterpret_cast<void*>(addr), len };
        if (process_vm_readv(pid, &local, 1, &remote, 1, 0) == static_cast<ssize_t>(len)) return true;
        
        int f = fd();
        if (f < 0) return false;
        size_t got = 0;
        while (got < len) {
            ssize_t r = pread(f, static_cast<char*>(buf) + got, len - got, static_cast<off_t>(addr + got));
            if (r <= 0) return false;
            got += static_cast<size_t>(r);
        }
        return true;
    }

    template<typename T>
    inline bool read(uint64_t addr, T& val) const {
        return readRaw(addr, &val, sizeof(T));
    }

    std::string readIl2CppString(uint64_t ptr, int cap = 64) const {
        if (ptr < 0x1000 || ptr > 0x7fffffffffffULL) return "";
        int32_t len = 0;
        if (!read(ptr + Constants::STR_LEN, len) || len <= 0 || len > cap) return "";

        std::vector<uint16_t> wchars(len);
        if (!readRaw(ptr + Constants::STR_CHARS, wchars.data(), len * sizeof(uint16_t))) return "";

        std::string out;
        out.reserve(len + 8);
        for (uint16_t wc : wchars) {
            if (wc == '"') out += "\\\"";
            else if (wc == '\\') out += "\\\\";
            else if (wc < 0x20) out += '?';                  // control chars break JSON
            else if (wc < 128) out += static_cast<char>(wc);
            else out += '?';
        }
        return out;
    }

    // mapping [start,end) that contains addr (for bounding the heap scan)
    bool regionFor(uint64_t addr, uint64_t& start, uint64_t& end) const {
        std::ifstream maps("/proc/" + std::to_string((int)pid) + "/maps");
        std::string line;
        while (std::getline(maps, line)) {
            unsigned long long s = 0, e = 0;
            if (sscanf(line.c_str(), "%llx-%llx", &s, &e) == 2) {
                if (addr >= s && addr < e) { start = s; end = e; return true; }
            }
        }
        return false;
    }

    // all writable mappings (the heap scan spans multiple il2cpp GC arenas)
    std::vector<std::pair<uint64_t, uint64_t>> rwRegions() const {
        std::vector<std::pair<uint64_t, uint64_t>> out;
        std::ifstream maps("/proc/" + std::to_string((int)pid) + "/maps");
        std::string line;
        while (std::getline(maps, line)) {
            unsigned long long s = 0, e = 0;
            char perms[8] = {0};
            if (sscanf(line.c_str(), "%llx-%llx %7s", &s, &e, perms) == 3) {
                // anonymous only — file-backed rw (dalvik/.so data) never holds il2cpp objects
                if (line.find('/') != std::string::npos) continue;
                if (perms[0] == 'r' && perms[1] == 'w' && e > s) out.emplace_back(s, e);
            }
        }
        return out;
    }
};

struct CachedNames {
    int32_t id = -1;
    std::string name;
    std::string hname;
};

struct CachedSkills {
    int sk4[4] = {-1, -1, -1, -1};
    int sp = -1;
    int sm = -1;
};

static void writeFrameAtomic(const std::string& data) {
    static const char* tmpPath = "/data/local/tmp/frame.json.tmp";
    static const char* dstPath = "/data/local/tmp/frame.json";

    FILE* fp = fopen(tmpPath, "w");
    if (!fp) return;
    fwrite(data.data(), 1, data.size(), fp);
    fclose(fp);
    rename(tmpPath, dstPath); // POSIX atomic rename — 0 shell overhead
}

class MobaReader {
    const ProcessMemory& mem;
    const Config& cfg;
    int pid;
    uint64_t libcsharp = 0;
    uint32_t now = 0;

    std::unordered_set<uint32_t> seen;
    std::unordered_map<uint32_t, uint64_t> guidMap;
    std::unordered_map<uint32_t, CachedNames> nameCache;
    std::unordered_map<uint32_t, CachedSkills> skillCache;

    // Reusable scrap buffers to eliminate heap churn in hot loop
    std::vector<uint8_t> dictBuf;
    std::vector<uint64_t> ptrBuf;
    std::string out_buf;
    uint32_t frame_count = 0;
    double match_start_sec = 0.0;

    // draft heap-scan state (no frida): klass bootstrapped from an ally RoomData
    struct DraftRow {
        uint64_t uid = 0;
        uint64_t addr = 0;
        uint32_t camp = 0, pos = 0, heroid = 0, country = 0, rank_ = 0, road = 0;
        uint8_t robot = 0;
        std::string name;
        std::vector<uint32_t> want;          // preselected ("want to pick") heroes
    };
    std::vector<uint8_t> scanBuf;
    std::string draftJson = "[]";
    int draftN = 0;
    uint32_t draftFrame = 0;
    bool draftDirty = true;
    std::vector<uint64_t> lastAllyUids;
    bool wasInBattle = false;
    int notInBattleCount = 0;
    bool dbg = false;                            // SPELLDBG=1 -> stderr diagnostics

    static uint64_t findModuleBase(int targetPid, const std::string& name) {
        std::ifstream maps("/proc/" + std::to_string(targetPid) + "/maps");
        std::string line;
        while (std::getline(maps, line)) {
            if (line.find(name) != std::string::npos) {
                return std::strtoull(line.c_str(), nullptr, 16);
            }
        }
        return 0;
    }

    void walkRegistry(uint64_t lbm, int off) {
        uint64_t dic = 0;
        if (!mem.read(lbm + off, dic) || dic < 0x1000) return;

        uint64_t entries = 0;
        int32_t count = 0;
        if (!mem.read(dic + Constants::DICT_ENTRIES, entries) || !mem.read(dic + Constants::DICT_COUNT, count)) return;
        if (count <= 0 || count > 4096) return;

        uint32_t maxlen = 0;
        if (!mem.read(entries + 0x18, maxlen)) return;
        count = std::min(count, static_cast<int32_t>(maxlen));
        if (count == 0) return;

        // BATCH READ: Slurp entire entry array in 1 syscall
        size_t totalBytes = count * Constants::DICT_STRIDE;
        if (dictBuf.size() < totalBytes) dictBuf.resize(totalBytes);

        if (!mem.readRaw(entries + Constants::ARR_DATA, dictBuf.data(), totalBytes)) return;

        for (int i = 0; i < count && guidMap.size() < Constants::MAP_MAX; ++i) {
            const uint8_t* eptr = dictBuf.data() + (i * Constants::DICT_STRIDE);
            int32_t key;
            uint64_t val;
            std::memcpy(&key, eptr + 8, 4);
            std::memcpy(&val, eptr + 0x10, 8);

            if (key != 0 && val >= 0x1000) {
                guidMap[static_cast<uint32_t>(key)] = val;
            }
        }
    }

    void resolveNow() {
        now = 0;
        guidMap.clear();

        uint64_t inst = 0;
        if (libcsharp && cfg.slot_lbm) {
            uint64_t klass = 0, sfd = 0;
            if (mem.read(libcsharp + cfg.slot_lbm, klass) && klass >= 0x1000 &&
                mem.read((klass & 0x00FFFFFFFFFFFFFFULL) + cfg.sf_off, sfd) && sfd >= 0x1000)
                mem.read(sfd + cfg.lbmi_off, inst);
        }
        if (!inst && cfg.klass_lbm) {
            uint64_t sfd = 0;
            if (mem.read(cfg.klass_lbm + cfg.sf_off, sfd) && sfd >= 0x1000)
                mem.read(sfd + cfg.lbmi_off, inst);
        }
        if (!inst && libcsharp && cfg.timer_klass_slot) {
            uint64_t klass = 0, sfd = 0;
            if (mem.read(libcsharp + cfg.timer_klass_slot, klass) && klass >= 0x1000 &&
                mem.read(klass + cfg.sf_off, sfd) && sfd >= 0x1000)
                mem.read(sfd, inst);
        }
        if (!inst || inst < 0x1000) return;

        uint32_t t = 0;
        if (mem.read(inst + cfg.now_off, t)) now = t;

        walkRegistry(inst, cfg.lbm_player_off);    // m_dicPlayerLogic  (was 168)
        walkRegistry(inst, cfg.lbm_monster_off);   // m_dicMonsterLogic (was 176)
    }

    void spellWalk(uint64_t ent, uint32_t g, int (&sk4)[4], int& sp) {
        std::fill(std::begin(sk4), std::end(sk4), -1);
        sp = -1;
        if (!now) return;

        uint64_t own = 0, list = 0;
        if (cfg.e_ownskill < 0 || !mem.read(ent + cfg.e_ownskill, own) || own < 0x1000) return;
        if (cfg.own_skilllist < 0 || !mem.read(own + cfg.own_skilllist, list) || list < 0x1000) return;

        uint64_t arr = 0;
        int32_t size = 0;
        if (!mem.read(list + Constants::LIST_ITEMS, arr) || !mem.read(list + Constants::LIST_SIZE, size)) return;
        if (size <= 0 || size > 32) return;

        // BATCH READ: Slurp skill array pointers
        std::vector<uint64_t> sdList(size);
        if (!mem.readRaw(arr + Constants::ARR_DATA, sdList.data(), size * sizeof(uint64_t))) return;

        std::vector<int32_t> tran(size, -1);
        for (int i = 0; i < size; ++i) {
            uint64_t sd = sdList[i];
            if (sd >= 0x1000 && cfg.sd_tranid >= 0) {
                mem.read(sd + cfg.sd_tranid, tran[i]);
            }
        }

        uint64_t fighter = 0;
        auto it = guidMap.find(g);
        if (it != guidMap.end()) fighter = it->second;
        if (!fighter && cfg.fighter_cache >= 0) mem.read(ent + cfg.fighter_cache, fighter);
        if (fighter < 0x1000) return;

        uint64_t sc = 0, cdc = 0, dic = 0;
        if (cfg.lf_skillcomp < 0 || !mem.read(fighter + cfg.lf_skillcomp, sc) || sc < 0x1000) return;
        if (cfg.lsc_coolcomp < 0 || !mem.read(sc + cfg.lsc_coolcomp, cdc) || cdc < 0x1000) return;
        if (cfg.cdc_diccool < 0 || !mem.read(cdc + cfg.cdc_diccool, dic) || dic < 0x1000) return;

        uint64_t entries = 0;
        int32_t count = 0;
        if (!mem.read(dic + Constants::DICT_ENTRIES, entries) || !mem.read(dic + Constants::DICT_COUNT, count)) return;
        if (count <= 0 || count > 64) return;

        uint32_t maxlen = 0;
        if (!mem.read(entries + 0x18, maxlen)) return;
        count = std::min(count, static_cast<int32_t>(maxlen));
        if (count == 0) return;

        int32_t summon = -1;
        if (cfg.e_summonid >= 0) mem.read(ent + cfg.e_summonid, summon);

        // BATCH READ: Slurp cooldown dictionary entries
        size_t cdBytes = count * Constants::DICT_STRIDE;
        std::vector<uint8_t> cdBuf(cdBytes);
        if (!mem.readRaw(entries + Constants::ARR_DATA, cdBuf.data(), cdBytes)) return;

        bool spFound = false;
        std::vector<int32_t> found(32, -1);

        for (int i = 0; i < count; ++i) {
            const uint8_t* eptr = cdBuf.data() + (i * Constants::DICT_STRIDE);
            int32_t key = -1;
            uint64_t cd = 0;
            std::memcpy(&key, eptr + 8, 4);
            std::memcpy(&cd, eptr + Constants::DICT_VALUE, 8);

            if (cd < 0x1000) continue;

            // Reading a and b in a single 8-byte read if consecutive, or individual reads
            uint32_t a = 0, b = 0;
            if (cfg.cd_a >= 0) mem.read(cd + cfg.cd_a, a);
            if (cfg.cd_b >= 0) mem.read(cd + cfg.cd_b, b);

            uint32_t end = a + b;
            int32_t rem = static_cast<int32_t>(end >= now ? (end - now) : 0);
            int32_t secs = rem / 1000;

            for (size_t t = 0; t < tran.size() && t < 32; ++t) {
                if (tran[t] != -1 && tran[t] == key && t >= 1 && t <= 4) found[t] = secs;
            }
            if (summon != -1 && key == summon) {
                sp = secs;
                spFound = true;
            }
        }

        for (int t = 1; t <= 4; ++t) {
            sk4[t - 1] = (found[t] >= 0 ? found[t] : 0);
        }
        if (summon != -1 && !spFound) sp = 0;
    }

    bool emitEntity(uint64_t ent, bool isSelf, bool& comma) {
        if (ent < 0x1000) return false;

        alignas(8) uint8_t raw[Constants::ENTITY_SLICE];
        if (!mem.readRaw(ent, raw, sizeof(raw))) return false;

        uint32_t guid = (cfg.e_guid >= 0) ? *reinterpret_cast<uint32_t*>(raw + cfg.e_guid) : 0;
        uint8_t death = (cfg.e_death >= 0) ? raw[cfg.e_death] : 0;
        if (death && !isSelf) return false;
        if (guid != 0 && !seen.insert(guid).second) return false;

        int32_t id       = (cfg.e_id >= 0) ? *reinterpret_cast<int32_t*>(raw + cfg.e_id) : 0;
        int32_t camp     = (cfg.e_camp >= 0) ? *reinterpret_cast<int32_t*>(raw + cfg.e_camp) : 0;
        uint8_t ally     = (cfg.e_samecamp >= 0) ? raw[cfg.e_samecamp] : 0;
        uint8_t cansight = (cfg.e_cansight >= 0) ? raw[cfg.e_cansight] : 0;
        int32_t hp       = (cfg.e_hp >= 0) ? *reinterpret_cast<int32_t*>(raw + cfg.e_hp) : 0;
        int32_t hpmax    = (cfg.e_hpmax >= 0) ? *reinterpret_cast<int32_t*>(raw + cfg.e_hpmax) : 0;

        float px = 0.0f, py = 0.0f, pz = 0.0f;
        if (cfg.e_pos >= 0) {
            const float* p = reinterpret_cast<const float*>(raw + cfg.e_pos);
            px = p[0]; py = p[1]; pz = p[2];
        }

        auto nameIt = nameCache.find(guid);
        if (guid != 0 && (nameIt == nameCache.end() || nameIt->second.id != id)) {
            std::string n, hn;
            if (cfg.e_name >= 0) {
                uint64_t ptr = *reinterpret_cast<uint64_t*>(raw + cfg.e_name);
                if (ptr >= 0x1000) n = mem.readIl2CppString(ptr);
            }
            if (cfg.sp_heroname >= 0) {
                uint64_t ptr = *reinterpret_cast<uint64_t*>(raw + cfg.sp_heroname);
                if (ptr >= 0x1000) hn = mem.readIl2CppString(ptr);
            }
            nameCache[guid] = CachedNames{id, std::move(n), std::move(hn)};
            nameIt = nameCache.find(guid);
        }

        int32_t summon = -1;
        if (cfg.e_summonid >= 0 && cfg.e_summonid + static_cast<int32_t>(sizeof(int32_t)) <= static_cast<int32_t>(sizeof(raw))) {
            summon = *reinterpret_cast<const int32_t*>(raw + cfg.e_summonid);
        }

        CachedSkills& sk = skillCache[guid];
        sk.sm = summon;
        if (cfg.e_ownskill >= 0 && (frame_count % 4 == 0 || sk.sp == -1)) {
            spellWalk(ent, guid, sk.sk4, sk.sp);
        }

        if (comma) out_buf += ',';
        comma = true;

        float dx = 0.0f, dz = 0.0f;
        if (cfg.e_movedir >= 0) {
            const float* d = reinterpret_cast<const float*>(raw + cfg.e_movedir);
            dx = d[0]; dz = d[2];
        }
        double spd = (cfg.e_movespeed >= 0) ? *reinterpret_cast<const double*>(raw + cfg.e_movespeed) : 0.0;
        int32_t grass = (cfg.e_grass >= 0) ? *reinterpret_cast<const int32_t*>(raw + cfg.e_grass) : 0;
        int32_t invis = (cfg.e_invis >= 0) ? *reinterpret_cast<const int32_t*>(raw + cfg.e_invis) : 0;
        int32_t lvl   = (cfg.e_lvl >= 0) ? *reinterpret_cast<const int32_t*>(raw + cfg.e_lvl) : 0;
        int32_t mp    = (cfg.e_mp >= 0) ? *reinterpret_cast<const int32_t*>(raw + cfg.e_mp) : 0;
        int32_t mpmax = (cfg.e_mpmax >= 0) ? *reinterpret_cast<const int32_t*>(raw + cfg.e_mpmax) : 0;
        uint8_t inbat = (cfg.sp_inbattle >= 0) ? raw[cfg.sp_inbattle] : 0;
        int32_t gold  = (cfg.sp_gold >= 0) ? *reinterpret_cast<const int32_t*>(raw + cfg.sp_gold) : 0;

        std::string anim;
        if (cfg.e_anim >= 0) {
            uint64_t aptr = *reinterpret_cast<const uint64_t*>(raw + cfg.e_anim);
            if (aptr >= 0x1000) anim = mem.readIl2CppString(aptr, 32);
        }

        const std::string& n = (nameIt != nameCache.end()) ? nameIt->second.name : "";
        const std::string& hn = (nameIt != nameCache.end()) ? nameIt->second.hname : "";

        static std::unordered_map<uint32_t, int32_t> lastLoggedSummon;
        if (guid != 0 && summon != -1 && lastLoggedSummon[guid] != summon) {
            lastLoggedSummon[guid] = summon;
            FILE* fp = fopen("/data/local/tmp/summon_skills.log", "a");
            if (fp) {
                time_t tnow = time(nullptr);
                struct tm tm_info;
                localtime_r(&tnow, &tm_info);
                char tstr[32];
                strftime(tstr, sizeof(tstr), "%H:%M:%S", &tm_info);
                fprintf(fp, "[%s] [SUMMON] guid=%u id=%d camp=%d ally=%d hero='%s' name='%s' summonId=%d (0x%X)\n",
                        tstr, guid, id, camp, ally ? 1 : 0, hn.c_str(), n.c_str(), summon, static_cast<unsigned>(summon));
                fclose(fp);
            }
        }

        char buf[800];
        int len = snprintf(buf, sizeof(buf),
            "{\"g\":%u,\"id\":%d,\"camp\":%d,\"ally\":%d,\"fog\":%d,\"p\":[%.2f,%.2f,%.2f],\"hp\":%d,\"hm\":%d,\"mp\":%d,\"mm\":%d,\"n\":\"%s\",\"hn\":\"%s\",\"sk\":[%d,%d,%d,%d],\"sp\":%d,\"sm\":%d,\"dir\":[%.2f,%.2f],\"spd\":%.1f,\"grass\":%d,\"inv\":%d,\"lvl\":%d,\"bat\":%d,\"gld\":%d,\"an\":\"%s\"}",
            guid, id, camp, ally ? 1 : 0, cansight ? 0 : 1, px, py, pz, hp, hpmax, mp, mpmax,
            n.c_str(), hn.c_str(), sk.sk4[0], sk.sk4[1], sk.sk4[2], sk.sk4[3], sk.sp, summon,
            dx, dz, spd, grass, invis, lvl, inbat ? 1 : 0, gold, anim.c_str());

        out_buf.append(buf, len);
        return true;
    }

    int emitList(uint64_t list, bool& comma) {
        uint64_t arr = 0;
        int32_t size = 0;
        if (!mem.read(list + Constants::LIST_ITEMS, arr) || !mem.read(list + Constants::LIST_SIZE, size)) return 0;
        uint32_t alen = 0;
        if (mem.read(arr + Constants::ARR_LEN, alen)) size = std::min(size, static_cast<int32_t>(alen));
        if (size <= 0 || size > 512) return 0;

        // BATCH READ: Slurp entire pointer table
        if (ptrBuf.size() < static_cast<size_t>(size)) ptrBuf.resize(size);
        if (!mem.readRaw(arr + Constants::ARR_DATA, ptrBuf.data(), size * sizeof(uint64_t))) return 0;

        int count = 0;
        for (int i = 0; i < size; ++i) {
            uint64_t ent = ptrBuf[i];
            if (ent >= 0x1000 && emitEntity(ent, false, comma)) {
                ++count;
            }
        }
        return count;
    }

    int emitDict(uint64_t dict, bool& comma) {
        uint64_t entries = 0;
        int32_t count_ = 0;
        if (!mem.read(dict + Constants::DICT_ENTRIES, entries) || !mem.read(dict + Constants::DICT_COUNT, count_)) return 0;
        if (count_ <= 0 || count_ > 512) return 0;

        uint32_t maxlen = 0;
        if (!mem.read(entries + 0x18, maxlen)) return 0;
        count_ = std::min(count_, static_cast<int32_t>(maxlen));
        if (count_ == 0) return 0;

        // BATCH READ: Slurp all dictionary items at once
        size_t totalBytes = count_ * Constants::DICT_STRIDE;
        if (dictBuf.size() < totalBytes) dictBuf.resize(totalBytes);
        if (!mem.readRaw(entries + Constants::ARR_DATA, dictBuf.data(), totalBytes)) return 0;

        int count = 0;
        for (int i = 0; i < count_; ++i) {
            const uint8_t* eptr = dictBuf.data() + (i * Constants::DICT_STRIDE);
            uint64_t ent = 0;
            std::memcpy(&ent, eptr + Constants::DICT_VALUE, sizeof(uint64_t));
            if (ent >= 0x1000 && emitEntity(ent, false, comma)) {
                ++count;
            }
        }
        return count;
    }

    // ---- draft mode: Friends.RoomDataManager -> MTTDProto.RoomPlayerInfo ----
    uint64_t getRoomDataManager() {
        // preferred: session-resolved static address of RoomDataManager._instance
        if (cfg.st_room_instance) {
            uint64_t inst = 0;
            if (mem.read(cfg.st_room_instance, inst) && inst >= 0x1000) return inst;
        }
        // fallback: codegen usage slot pattern
        if (!libcsharp || !cfg.slot_room) return 0;
        uint64_t klass = 0, sfd = 0, inst = 0;
        if (mem.read(libcsharp + cfg.slot_room, klass) && klass >= 0x1000 &&
            mem.read((klass & 0x00FFFFFFFFFFFFFFULL) + cfg.sf_off, sfd) && sfd >= 0x1000)
            mem.read(sfd, inst);
        return inst;
    }

    // emit a Dictionary<uint32,uint32>'s top-N entries (used for mHeroMMR favourites)
    void emitTopDict(uint64_t dict, int top, std::vector<std::pair<uint32_t, uint32_t>>& out) {
        uint64_t entries = 0;
        int32_t count = 0;
        if (!mem.read(dict + Constants::DICT_ENTRIES, entries) || !mem.read(dict + Constants::DICT_COUNT, count)) return;
        if (count <= 0 || count > 512) return;
        uint32_t maxlen = 0;
        if (!mem.read(entries + 0x18, maxlen)) return;
        count = std::min(count, static_cast<int32_t>(maxlen));
        if (count == 0) return;
        size_t bytes = count * Constants::DICT_STRIDE;
        if (dictBuf.size() < bytes) dictBuf.resize(bytes);
        if (!mem.readRaw(entries + Constants::ARR_DATA, dictBuf.data(), bytes)) return;
        for (int i = 0; i < count; ++i) {
            const uint8_t* e = dictBuf.data() + i * Constants::DICT_STRIDE;
            uint32_t k, v;
            std::memcpy(&k, e + 8, 4);
            std::memcpy(&v, e + 0x10, 4);
            if (k) out.emplace_back(k, v);
        }
        std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.second > b.second; });
        if ((int)out.size() > top) out.resize(top);
    }

    void emitListU32(uint64_t list, std::vector<uint32_t>& out) {
        uint64_t arr = 0;
        int32_t size = 0;
        if (!mem.read(list + Constants::LIST_ITEMS, arr) || !mem.read(list + Constants::LIST_SIZE, size)) return;
        if (size <= 0 || size > 16) return;
        uint32_t alen = 0;
        if (mem.read(arr + Constants::ARR_LEN, alen)) size = std::min(size, static_cast<int32_t>(alen));
        if (size <= 0) return;
        std::vector<uint32_t> v(size);
        if (mem.readRaw(arr + Constants::ARR_DATA, v.data(), size * 4)) out = std::move(v);
    }

    bool emitRoomPlayer(uint64_t rpi, bool& comma) {
        if (rpi < 0x1000) return false;
        alignas(8) uint8_t raw[0x180];
        if (!mem.readRaw(rpi, raw, sizeof(raw))) return false;

        uint64_t uid    = *reinterpret_cast<uint64_t*>(raw + cfg.rpi_uid);
        uint32_t svr    = *reinterpret_cast<uint32_t*>(raw + cfg.rpi_svr);
        uint32_t rank   = *reinterpret_cast<uint32_t*>(raw + cfg.rpi_rank);
        uint32_t rankb  = *reinterpret_cast<uint32_t*>(raw + cfg.rpi_rankbig);
        uint32_t nation = *reinterpret_cast<uint32_t*>(raw + cfg.rpi_nation);
        uint32_t road   = *reinterpret_cast<uint32_t*>(raw + cfg.rpi_road);
        uint32_t camp   = *reinterpret_cast<uint32_t*>(raw + cfg.rpi_camp);
        uint8_t  ready  = raw[cfg.rpi_ready];
        uint8_t  online = raw[cfg.rpi_online];

        uint64_t namePtr = *reinterpret_cast<uint64_t*>(raw + cfg.rpi_name);
        std::string name = mem.readIl2CppString(namePtr);

        uint64_t base = *reinterpret_cast<uint64_t*>(raw + cfg.rpi_base);

        if (comma) out_buf += ',';
        comma = true;
        out_buf += "{\"uid\":";
        out_buf += std::to_string(uid);
        out_buf += ",\"svr\":";
        out_buf += std::to_string(svr);
        out_buf += ",\"name\":\"";
        out_buf += name;
        out_buf += "\",\"rank\":";
        out_buf += std::to_string(rank);
        out_buf += ",\"rankBig\":";
        out_buf += std::to_string(rankb);
        out_buf += ",\"nation\":";
        out_buf += std::to_string(nation);
        out_buf += ",\"camp\":";
        out_buf += std::to_string(camp);
        out_buf += ",\"road\":";
        out_buf += std::to_string(road);
        out_buf += ",\"ready\":";
        out_buf += (ready ? "true" : "false");
        out_buf += ",\"online\":";
        out_buf += std::to_string(online ? 1 : 0);

        if (base >= 0x1000) {
            // PlayerBaseInfo.mHeroMMR = Dictionary<heroId, MMR> -> top favourites
            uint64_t dict = 0;
            if (mem.read(base + cfg.pbi_herommr, dict) && dict >= 0x1000) {
                std::vector<std::pair<uint32_t, uint32_t>> favs;
                emitTopDict(dict, cfg.room_favtop, favs);
                out_buf += ",\"favs\":[";
                for (size_t i = 0; i < favs.size(); ++i) {
                    if (i) out_buf += ',';
                    out_buf += "[";
                    out_buf += std::to_string(favs[i].first);
                    out_buf += ',';
                    out_buf += std::to_string(favs[i].second);
                    out_buf += ']';
                }
                out_buf += ']';
            }
            uint32_t vt = 0, vs = 0;
            mem.read(base + cfg.pbi_vtimes, vt);
            mem.read(base + cfg.pbi_vscore, vs);
            out_buf += ",\"vt\":";
            out_buf += std::to_string(vt);
            out_buf += ",\"vs\":";
            out_buf += std::to_string(vs);
        }

        if (cfg.rpi_want >= 0) {
            uint64_t want = *reinterpret_cast<uint64_t*>(raw + cfg.rpi_want);
            std::vector<uint32_t> heroes;
            emitListU32(want, heroes);
            out_buf += ",\"want\":[";
            for (size_t i = 0; i < heroes.size(); ++i) {
                if (i) out_buf += ',';
                out_buf += std::to_string(heroes[i]);
            }
            out_buf += ']';
        }

        out_buf += '}';
        return true;
    }

    int emitRoomFrame(bool& comma) {
        uint64_t mgr = getRoomDataManager();
        if (mgr < 0x1000) return -1;
        uint64_t dict = 0;
        if (!mem.read(mgr + cfg.rd_players, dict) || dict < 0x1000) return -1;

        uint64_t entries = 0;
        int32_t count = 0;
        if (!mem.read(dict + Constants::DICT_ENTRIES, entries) || !mem.read(dict + Constants::DICT_COUNT, count)) return -1;
        if (count <= 0 || count > 16) return -1;
        uint32_t maxlen = 0;
        if (!mem.read(entries + 0x18, maxlen)) return -1;
        count = std::min(count, static_cast<int32_t>(maxlen));
        if (count == 0) return -1;

        size_t bytes = count * Constants::DICT_STRIDE;
        if (dictBuf.size() < bytes) dictBuf.resize(bytes);
        if (!mem.readRaw(entries + Constants::ARR_DATA, dictBuf.data(), bytes)) return -1;

        int n = 0;
        for (int i = 0; i < count; ++i) {
            const uint8_t* e = dictBuf.data() + i * Constants::DICT_STRIDE;
            uint64_t uid = 0, rpi = 0;
            std::memcpy(&uid, e + 8, 8);
            std::memcpy(&rpi, e + Constants::DICT_VALUE, 8);
            if (rpi >= 0x1000 && emitRoomPlayer(rpi, comma)) ++n;
        }
        return n;
    }

    // ---- draft roster: external heap scan (no frida) ----
    uint64_t getChooseHeroMgr() {
        // preferred: codegen usage slot (libcsharp RVA -> klass -> statics -> instance),
        // session-stable so a fresh start-map needs no frida refresh.
        if (libcsharp && cfg.slot_choose) {
            uint64_t klass = 0, sfd = 0, inst = 0;
            if (mem.read(libcsharp + cfg.slot_choose, klass) && klass >= 0x1000 &&
                mem.read((klass & 0x00FFFFFFFFFFFFFFULL) + cfg.sf_off, sfd) && sfd >= 0x1000 &&
                mem.read(sfd + cfg.chi_off, inst) && inst >= 0x1000) return inst;
        }
        // fallback: per-session static address from port.json
        if (cfg.st_choose) {
            uint64_t inst = 0;
            if (mem.read(cfg.st_choose, inst) && inst >= 0x1000) return inst;
        }
        return 0;
    }

    // first ally RoomData object + its klass pointer (object header @+0)
    bool getAllyRoomData(uint64_t& obj, uint64_t& klass) {
        uint64_t mgr = getChooseHeroMgr();
        if (mgr < 0x1000 || cfg.ch_self_list < 0) return false;
        uint64_t list = 0;
        if (!mem.read(mgr + cfg.ch_self_list, list) || list < 0x1000) return false;
        uint64_t items = 0; int32_t size = 0;
        if (!mem.read(list + Constants::LIST_ITEMS, items) || !mem.read(list + Constants::LIST_SIZE, size)) return false;
        if (items < 0x1000 || size <= 0 || size > 64) return false;
        if (!mem.read(items + Constants::ARR_DATA, obj) || obj < 0x1000) return false;
        if (!mem.read(obj, klass) || klass < 0x1000) return false;
        return true;
    }

    void readDraftRow(uint64_t o, DraftRow& row) {
        row.addr = o;
        // single contiguous slurp instead of ~10 reads per row (ENTITY_SLICE precedent)
        int32_t need = 0;
        need = std::max({need, cfg.d_uid + 8, cfg.d_camp + 4, cfg.d_pos + 4, cfg.d_robot + 1,
                         cfg.d_heroid + 4, cfg.d_country + 4, cfg.d_rank + 4, cfg.d_road + 4,
                         cfg.d_name + 8, cfg.d_want + 8});
        uint64_t namePtr = 0, wp = 0;
        if (need <= static_cast<int32_t>(Constants::DRAFT_SLICE)) {
            alignas(8) uint8_t raw[Constants::DRAFT_SLICE];
            if (!mem.readRaw(o, raw, sizeof(raw))) return;   // all-or-nothing
            row.uid     = *reinterpret_cast<uint64_t*>(raw + cfg.d_uid);
            row.camp    = *reinterpret_cast<uint32_t*>(raw + cfg.d_camp);
            row.pos     = *reinterpret_cast<uint32_t*>(raw + cfg.d_pos);
            row.robot   = raw[cfg.d_robot];
            row.heroid  = *reinterpret_cast<uint32_t*>(raw + cfg.d_heroid);
            row.country = *reinterpret_cast<uint32_t*>(raw + cfg.d_country);
            row.rank_   = *reinterpret_cast<uint32_t*>(raw + cfg.d_rank);
            row.road    = *reinterpret_cast<uint32_t*>(raw + cfg.d_road);
            namePtr     = *reinterpret_cast<uint64_t*>(raw + cfg.d_name);
            wp          = *reinterpret_cast<uint64_t*>(raw + cfg.d_want);
        } else {
            // fallback if a future build pushes an offset past DRAFT_SLICE
            mem.read(o + cfg.d_uid, row.uid);
            mem.read(o + cfg.d_camp, row.camp);
            mem.read(o + cfg.d_pos, row.pos);
            mem.read(o + cfg.d_robot, row.robot);
            mem.read(o + cfg.d_heroid, row.heroid);
            mem.read(o + cfg.d_country, row.country);
            mem.read(o + cfg.d_rank, row.rank_);
            mem.read(o + cfg.d_road, row.road);
            mem.read(o + cfg.d_name, namePtr);
            mem.read(o + cfg.d_want, wp);
        }
        if (namePtr >= 0x1000) row.name = mem.readIl2CppString(namePtr, 32);
        if (wp >= 0x1000) emitListU32(wp, row.want);
    }

    void buildDraft() {
        if ((cfg.st_choose == 0 && cfg.slot_choose == 0) || cfg.ch_self_list < 0) {
            if (draftN == 0) { draftJson = "[]"; }
            return;
        }
        if (!draftDirty && frame_count - draftFrame < 45) return; // ~0.75s cadence
        draftFrame = frame_count;
        draftDirty = false;

        // your team comes straight off the list (reliable); only the enemy camp
        // needs the heap scan. klass is read from the first ally's object header.
        std::vector<DraftRow> allies;
        uint64_t klass = 0;
        readAllyRows(allies, klass);
        if (klass < 0x1000) {
            // Do NOT wipe draftJson if we already have a resolved draft!
            if (draftN == 0) { draftJson = "[]"; }
            return;
        }

        // Room/match change detection: if ally UIDs differ from last room, start fresh!
        if (!allies.empty()) {
            std::vector<uint64_t> curUids;
            curUids.reserve(allies.size());
            for (const auto& a : allies) {
                if (a.uid != 0) curUids.push_back(a.uid);
            }
            if (!curUids.empty() && curUids != lastAllyUids) {
                lastAllyUids = std::move(curUids);
                draftN = 0;
                draftJson = "[]";
                draftDirty = true;
            }
        }

        // your camp as carried by your own room entries; enemies are the OTHER camp.
        // (hardcoding camp==2 breaks whenever the client's side is camp 2)
        uint32_t selfCamp = 1;
        for (const auto& al : allies) if (al.camp) { selfCamp = al.camp; break; }
        if (dbg) fprintf(stderr, "[draft] selfCamp=%u allies=%zu\n", selfCamp, allies.size());

        if (scanBuf.size() < (1u << 18)) scanBuf.resize(1u << 18);  // 256 KB read chunks
        const uint64_t CHUNK = scanBuf.size();
        const uint64_t REGION_CAP = 0x10000000ULL; // 256 MB per region (fallback)
        const uint64_t ANCHOR_CAP = 0x4000000ULL;  // 64 MB per anchor region
        uint64_t budget = 0x60000000ULL;           // ~1.5 GB total (fallback)

        std::unordered_map<uint64_t, DraftRow> enemies;
        uint64_t n_klass = 0, n_camp_rej = 0, n_uid_rej = 0, scanned = 0;
        bool full = false;                          // 5 enemies found -> stop

        // A heap word equal to klass is not proof of a RoomData object: class
        // pointers also live inside arrays/fields, and reading draft offsets off
        // those yields pointer-tagged garbage (e.g. pos=0xB4000077, uid=6).
        // Accept a row only if every field is sane; otherwise the fakes fill the
        // 5-enemy cap and real rows later in the heap never get scanned.
        auto isPlausibleEnemy = [&](const DraftRow& r) {
            if (r.camp == 0 || r.camp > 4) return false;   // real camps are 1/2
            if (r.camp == selfCamp) return false;          // our own side
            if (r.pos > 10) return false;                  // 0-based or 1-based slots
            if (r.uid == 0) return false;                  // uninitialized row
            if (r.road > 5) return false;                  // lanes 0..5
            return true;
        };

        auto scanRange = [&](uint64_t rs, uint64_t re) {
            for (uint64_t a = rs; a + 8 <= re && budget > 0 && !full; ) {
                uint64_t n = std::min<uint64_t>(CHUNK, std::min<uint64_t>(re - a, budget));
                if (!mem.readRaw(a, scanBuf.data(), n)) { a += n; budget -= n; continue; }
                budget -= n; scanned += n;
                for (uint64_t i = 0; i + 8 <= n; i += 8) {
                    uint64_t v = 0;
                    std::memcpy(&v, scanBuf.data() + i, sizeof(uint64_t));
                    if (v != klass) continue;
                    uint64_t o = a + i;
                    ++n_klass;
                    uint32_t camp = 0;
                    if (!mem.read(o + cfg.d_camp, camp)) continue;
                    DraftRow row;
                    readDraftRow(o, row);
                    bool isAllyAddr = false;
                    for (const auto& al : allies) if (al.addr == o) { isAllyAddr = true; break; }
                    if (dbg && row.uid != 0)
                        fprintf(stderr, "[cand] addr=0x%llx camp=%u pos=%u heroid=%u uid=%llu name='%s'%s\n",
                                (unsigned long long)o, camp, row.pos, row.heroid,
                                (unsigned long long)row.uid, row.name.c_str(), isAllyAddr ? " ALLYADDR" : "");
                    // enemy = different camp than ours, and not literally one of our objects
                    if (camp == selfCamp || isAllyAddr) {
                        ++n_camp_rej;
                    } else if (isPlausibleEnemy(row)) {
                        if (dbg) fprintf(stderr, "[draft] ENEMY? addr=0x%llx uid=%llu camp=%u pos=%u heroid=%u road=%u name='%s'\n",
                                         (unsigned long long)o, (unsigned long long)row.uid, row.camp, row.pos,
                                         row.heroid, row.road, row.name.c_str());
                        auto it = enemies.find(row.uid);
                        if (it == enemies.end()) enemies.emplace(row.uid, std::move(row));
                        else if (it->second.heroid == 0 && row.heroid != 0) it->second = std::move(row);
                    } else {
                        ++n_uid_rej;   // rejected: bad camp/pos/uid/road (false positive)
                    }
                    if (enemies.size() >= 5) { full = true; break; }
                }
                a += n;
            }
        };

        // anchor: mappings that already hold our own RoomData — same arena as the enemies
        std::vector<std::pair<uint64_t, uint64_t>> anchors;
        for (const auto& al : allies) {
            bool covered = false;
            for (const auto& x : anchors) if (al.addr >= x.first && al.addr < x.second) { covered = true; break; }
            if (covered) continue;                       // avoid reopening /proc/pid/maps
            uint64_t s = 0, e = 0;
            if (mem.regionFor(al.addr, s, e)) anchors.emplace_back(s, e);
        }
        if (dbg) fprintf(stderr, "[draft] klass=0x%llx selfCamp=%u anchors=%zu\n",
                         (unsigned long long)klass, selfCamp, anchors.size());
        for (const auto& rg : anchors) {
            if (full || budget == 0) break;
            uint64_t end = std::min<uint64_t>(rg.second, rg.first + ANCHOR_CAP);
            if (dbg) fprintf(stderr, "[draft] anchor scan 0x%llx-0x%llx\n",
                             (unsigned long long)rg.first, (unsigned long long)end);
            scanRange(rg.first, end);
        }

        // fallback: everything else, only if the anchor pass didn't already find all 5
        if (!full) {
            for (const auto& rg : mem.rwRegions()) {
                if (full || budget == 0) break;
                uint64_t end = std::min<uint64_t>(rg.second, rg.first + REGION_CAP);
                scanRange(rg.first, end);
            }
        }
        if (dbg) fprintf(stderr, "[draft] scan done: scanned=%lluMB klassHits=%llu campRej=%llu uidRej=%llu enemies=%zu full=%d\n",
                         (unsigned long long)(scanned >> 20), (unsigned long long)n_klass,
                         (unsigned long long)n_camp_rej, (unsigned long long)n_uid_rej, enemies.size(), full ? 1 : 0);

        if (dbg) {
            std::unordered_map<uint64_t, uint64_t> allyUid2addr;
            for (const auto& r : allies) allyUid2addr[r.uid] = r.addr;
            for (const auto& kv : enemies) {
                const DraftRow& e = kv.second;
                auto ita = allyUid2addr.find(e.uid);
                const char* cls = "NEW";
                if (ita != allyUid2addr.end())
                    cls = (ita->second == e.addr) ? "MIRROR(same addr as ally)" : "DUP(same uid, diff addr)";
                fprintf(stderr, "[draft] camp2 uid=%llu addr=0x%llx -> %s\n",
                        (unsigned long long)e.uid, (unsigned long long)e.addr, cls);
            }
        }

        std::sort(allies.begin(), allies.end(), [](const DraftRow& a, const DraftRow& b) { return a.pos < b.pos; });
        std::vector<const DraftRow*> ev;
        ev.reserve(enemies.size());
        for (const auto& kv : enemies) ev.push_back(&kv.second);
        std::sort(ev.begin(), ev.end(), [](const DraftRow* a, const DraftRow* b) { return a->pos < b->pos; });

        std::string newDraft;
        newDraft += '[';
        int n = 0;
        auto emitRow = [&](const DraftRow& r, uint32_t camp) {
            if (n >= 10) return;
            if (n) newDraft += ',';
            char b[320];
            int len = snprintf(b, sizeof(b),
                "{\"uid\":%llu,\"camp\":%u,\"pos\":%u,\"name\":\"%s\",\"heroid\":%u,\"robot\":%u,"
                "\"country\":%u,\"rank\":%u,\"road\":%u",
                (unsigned long long)r.uid, camp, r.pos, r.name.c_str(), r.heroid,
                (unsigned)r.robot, r.country, r.rank_, r.road);
            if (len > 0) newDraft.append(b, static_cast<size_t>(len));
            newDraft += ",\"want\":[";
            for (size_t i = 0; i < r.want.size(); ++i) {
                if (i) newDraft += ',';
                newDraft += std::to_string(r.want[i]);
            }
            newDraft += "]}";
            ++n;
        };
        for (const DraftRow& r : allies) emitRow(r, 1);
        for (const DraftRow* r : ev) emitRow(*r, 2);
        newDraft += ']';

        if (n >= draftN) {
            draftJson = std::move(newDraft);
            draftN = n;
        }
    }

    void readAllyRows(std::vector<DraftRow>& out, uint64_t& klass) {
        klass = 0;
        uint64_t mgr = getChooseHeroMgr();
        if (mgr < 0x1000 || cfg.ch_self_list < 0) return;
        uint64_t list = 0;
        if (!mem.read(mgr + cfg.ch_self_list, list) || list < 0x1000) return;
        uint64_t items = 0; int32_t size = 0;
        if (!mem.read(list + Constants::LIST_ITEMS, items) || !mem.read(list + Constants::LIST_SIZE, size)) return;
        if (items < 0x1000 || size <= 0 || size > 32) return;
        uint32_t maxlen = 0;
        if (!mem.read(items + 0x18, maxlen)) return;
        size = std::min(size, static_cast<int32_t>(maxlen));
        if (dbg) fprintf(stderr, "[draft] chooseMgr=0x%llx selfList=0x%llx items=0x%llx n=%d\n",
                         (unsigned long long)mgr, (unsigned long long)list,
                         (unsigned long long)items, size);
        for (int i = 0; i < size; ++i) {
            uint64_t o = 0;
            if (!mem.read(items + Constants::ARR_DATA + static_cast<uint64_t>(i) * 8, o) || o < 0x1000) continue;
            if (i == 0) mem.read(o, klass);
            DraftRow row;
            readDraftRow(o, row);
            if (dbg) fprintf(stderr, "[draft] ALLY[%d] addr=0x%llx uid=%llu camp=%u pos=%u heroid=%u road=%u name='%s'\n",
                             i, (unsigned long long)o, (unsigned long long)row.uid, row.camp, row.pos,
                             row.heroid, row.road, row.name.c_str());
            if (row.camp == 0) row.camp = 1;
            out.push_back(std::move(row));
        }
    }

public:
    MobaReader(const ProcessMemory& pm, const Config& c, int p)
        : mem(pm), cfg(c), pid(p) {
        libcsharp = findModuleBase(pid, "libcsharp.so");
        out_buf.reserve(8192);
        seen.reserve(128);
        guidMap.reserve(Constants::MAP_MAX);
        nameCache.reserve(128);
        skillCache.reserve(128);
        dictBuf.resize(2048);
        ptrBuf.resize(128);
        dbg = std::getenv("SPELLDBG") != nullptr;
    }

    uint64_t getBattleManager() {
        if (libcsharp && cfg.slot_bm) {
            uint64_t klass = 0, sfd = 0, bm = 0;
            if (mem.read(libcsharp + cfg.slot_bm, klass) && klass >= 0x1000 &&
                mem.read((klass & 0x00FFFFFFFFFFFFFFULL) + cfg.sf_off, sfd) && sfd >= 0x1000 &&
                mem.read(sfd + cfg.bmi_off, bm) && bm >= 0x1000) return bm;
        }
        if (cfg.klass_bm) {
            uint64_t sfd = 0;
            if (mem.read(cfg.klass_bm + cfg.sf_off, sfd) && sfd >= 0x1000) {
                uint64_t bm = 0;
                if (mem.read(sfd + cfg.bmi_off, bm) && bm >= 0x1000) return bm;
            }
        }
        uint64_t bm = 0;
        mem.read(cfg.st_bm_instance, bm);
        return bm;
    }

    void renderFrame() {
        frame_count++;
        uint64_t bm = getBattleManager();
        seen.clear();
        out_buf.clear();

        auto now_boot = std::chrono::steady_clock::now().time_since_epoch();
        auto sec = std::chrono::duration_cast<std::chrono::seconds>(now_boot).count();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now_boot).count() % 1000;

        // local player decides whether we're in a live match. BattleManager can be
        // non-null during draft/loading (it previews the map), so bm alone is not
        // a reliable "in battle" signal — self resolution is.
        // Additionally, m_MainTowerDead (+128 / 0x80) flips to 1 the exact frame
        // the base / nexus is destroyed, allowing clean detection of match end
        // while BattleManager and self remain resident in memory.
        uint64_t self = 0;
        if (bm && cfg.bm_local >= 0) mem.read(bm + cfg.bm_local, self);
        uint8_t towerDead = 0;
        if (bm && cfg.bm_maintowerdead >= 0) mem.read(bm + cfg.bm_maintowerdead, towerDead);
        bool inBattle = (bm && self >= 0x1000 && !towerDead);
        double now_sec = static_cast<double>(sec) + (static_cast<double>(ms) / 1000.0);
        if (!inBattle) {
            notInBattleCount++;
            if (notInBattleCount >= 5 && wasInBattle) {
                wasInBattle = false;
                draftN = 0;
                draftJson = "[]";
                lastAllyUids.clear();
                draftDirty = true;
            }
            if (!nameCache.empty()) nameCache.clear();
            if (!skillCache.empty()) skillCache.clear();
            if (!guidMap.empty()) guidMap.clear();
            match_start_sec = 0.0;
        } else {
            notInBattleCount = 0;
            wasInBattle = true;
            if (match_start_sec == 0.0) {
                match_start_sec = now_sec;
            }
        }
        double gt = inBattle ? (now_sec - match_start_sec) : 0.0;
        bool roomCfg = (cfg.slot_room || cfg.st_room_instance);
        bool draftCfg = ((cfg.st_choose != 0 || cfg.slot_choose != 0) && cfg.ch_self_list >= 0);

        char head[128];
        int hlen = snprintf(head, sizeof(head), "{\"t\":%lld.%03ld,\"gt\":%.1f,\"bm\":%s,",
                            static_cast<long long>(sec), static_cast<long>(ms), gt, inBattle ? "1" : "0");
        out_buf.append(head, hlen);

        // ---- draft/lobby: no local player -> emit room info + external draft roster ----
        if (!inBattle && (roomCfg || draftCfg)) {
            out_buf += "\"room\":[";
            bool comma = false;
            int rn = roomCfg ? emitRoomFrame(comma) : -1;
            out_buf += "],\"rn\":";
            out_buf += std::to_string(rn < 0 ? 0 : rn);
            if (draftCfg) {
                buildDraft();
                out_buf += ",\"draft\":";
                out_buf += draftJson;
                out_buf += ",\"dn\":";
                out_buf += std::to_string(draftN);
            }
            out_buf += "}\n";
            fwrite(out_buf.data(), 1, out_buf.size(), stdout);
            fflush(stdout);
            writeFrameAtomic(out_buf);
            return;
        }
        // only walk battle registries + cooldown clocks when actually in a match
        // (the draft/lobby branch returned above)
        resolveNow();
        out_buf += "\"self\":";

        int n = 0;
        bool comma = false;

        if (inBattle) {
            emitEntity(self, true, comma);
            ++n;
        } else {
            out_buf += "null";
        }

        out_buf += ",\"heroes\":[";
        comma = false;
        if (bm) {
            uint64_t obj = 0;
            if (cfg.bm_players >= 0 && mem.read(bm + cfg.bm_players, obj)) n += emitList(obj, comma);
            if (cfg.bm_dicplayers >= 0 && mem.read(bm + cfg.bm_dicplayers, obj)) n += emitDict(obj, comma);
        }

        out_buf += "],\"jungle\":[";
        comma = false;
        if (bm) {
            uint64_t obj = 0;
            if (cfg.bm_monsters >= 0 && mem.read(bm + cfg.bm_monsters, obj)) n += emitList(obj, comma);
            if (cfg.bm_dicmonsters >= 0 && mem.read(bm + cfg.bm_dicmonsters, obj)) n += emitDict(obj, comma);
        }

        // Draft propagation in battle: emit cached draft without running expensive 1.5GB heap scans
        if (draftCfg) {
            // NOTE: buildDraft() scans up to 1.5GB of memory. Running this in-battle freezes the stream every 30 frames!
            // In battle, we only emit the draft already resolved during the lobby/draft phase.
            if (draftN > 0 && (frame_count % 60 == 0 || frame_count < 10)) {
                out_buf += "],\"draft\":";
                out_buf += draftJson;
                out_buf += ",\"dn\":";
                out_buf += std::to_string(draftN);
                char tail[64];
                int tlen = snprintf(tail, sizeof(tail), ",\"n\":%d}\n", n);
                out_buf.append(tail, tlen);
            } else {
                char tail[64];
                int tlen = snprintf(tail, sizeof(tail), "],\"n\":%d}\n", n);
                out_buf.append(tail, tlen);
            }
        } else {
            char tail[64];
            int tlen = snprintf(tail, sizeof(tail), "],\"n\":%d}\n", n);
            out_buf.append(tail, tlen);
        }

        fwrite(out_buf.data(), 1, out_buf.size(), stdout);
        fflush(stdout);
        writeFrameAtomic(out_buf);
    }
};

static void pinToEfficiencyCores() {
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(0, &cpuset); // Little Core 0
    CPU_SET(1, &cpuset); // Little Core 1
    sched_setaffinity(0, sizeof(cpu_set_t), &cpuset);
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: " << argv[0] << " <pid> [interval_ms]\n";
        return 1;
    }

    pinToEfficiencyCores();

    int pid = std::atoi(argv[1]);
    int ms = (argc >= 3) ? std::max(16, std::atoi(argv[2])) : 16;

    prctl(PR_SET_NAME, "logd", 0, 0, 0);
    for (int i = 0; i < argc; ++i) {
        std::memset(argv[i], 0, std::strlen(argv[i]));
    }
    std::strcpy(argv[0], "logd");

    Config cfg;
    if (!cfg.loadFromStream(std::cin)) {
        std::cerr << "failed to read config from stdin\n";
        return 1;
    }

    ProcessMemory mem(pid);
    if (!mem.isValid()) return 1;

    MobaReader reader(mem, cfg, pid);

    while (isProcessAlive(pid)) {
        reader.renderFrame();
        std::this_thread::sleep_for(std::chrono::milliseconds(ms));
    }

    return 0;
}