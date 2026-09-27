"use strict";

// ---------------- Live Match Recorder & Storage Manager ----------------
let isRecording = false;
let recordBuffer = [];
let recordIntervalId = null;
let recordStartTime = 0;

function renderLiveFrame(f) {
  if (!f) return;
  if (f.self && f.self.camp) selfCamp = f.self.camp;
  drawScene();

  const selfGuid = f.self ? f.self.g : -1;
  if (f.self) drawEntity(f.self, true);
  for (const h of f.heroes || []) {
    if (h.g === selfGuid) continue;
    drawEntity(h, false);
  }
  for (const m of f.jungle || []) drawJungle(m);

  const gt = f.gt !== undefined ? f.gt : 0;
  const fmtTime = s => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  if ($("timeReadout")) $("timeReadout").textContent = `LIVE ${fmtTime(gt)}`;
  if ($("hud-gt")) $("hud-gt").textContent = `gt: ${fmtTime(gt)} (${gt.toFixed(1)}s)`;
  if ($("hud-frame")) $("hud-frame").textContent = `rec: ${recordBuffer.length} frames`;
  if ($("hud-side")) {
    $("hud-side").textContent = `Side: ${selfCamp === 2 ? "Red" : "Blue"}`;
    $("hud-side").style.color = selfCamp === 2 ? "#ef5350" : "#42a5f5";
  }
}

function startLiveRecord() {
  if (engine.isPlaying) engine.togglePlay();
  isRecording = true;
  recordBuffer = [];
  recordStartTime = Date.now();
  $("btn-rec-start").disabled = true;
  $("btn-rec-stop").disabled = false;
  $("recBadge").style.display = "inline-block";
  $("recStatus").textContent = "Recording... (* >ω<)";
  $("matchBadge").textContent = "Live Match (Recording) (* >ω<)";
  $("matchBadge").className = "badge rec";

  recordIntervalId = setInterval(async () => {
    try {
      const r = await fetch("map.json?x=" + Date.now(), { cache: "no-store" });
      const d = await r.json();
      if (d && (d.bm || d.self)) {
        recordBuffer.push(d);
        const elapsedSec = Math.floor((Date.now() - recordStartTime) / 1000);
        $("recBadge").textContent = `[REC] ${elapsedSec}s (${recordBuffer.length}f) (* >ω<)`;
        if (recordBuffer.length === 1 && (d.heroes || d.draft)) {
          renderRoster(d.draft || d.heroes);
        }
        renderLiveFrame(d);
      }
    } catch (e) { }
  }, 150); // ~6.6 Hz
}

async function stopLiveRecord() {
  isRecording = false;
  clearInterval(recordIntervalId);
  $("btn-rec-start").disabled = false;
  $("btn-rec-stop").disabled = true;
  $("recBadge").style.display = "none";
  $("recStatus").textContent = `Captured ${recordBuffer.length} frames (・∀・)`;

  if (recordBuffer.length < 5) {
    alert("Too few frames captured to form a replay.");
    return;
  }

  const matchId = `rec_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const replayObj = {
    version: 1,
    matchId: matchId,
    recordedAt: new Date().toISOString(),
    selfCamp: recordBuffer[0].self ? recordBuffer[0].self.camp : 1,
    duration: (recordBuffer[recordBuffer.length - 1].gt || 0) - (recordBuffer[0].gt || 0),
    frames: recordBuffer
  };

  engine.load(replayObj);

  // Send to server
  try {
    await fetch("/save_replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replayObj)
    });
    loadServerReplays();
  } catch (e) { }
}

async function loadServerReplays() {
  const container = $("serverReplaysList");
  if (!container) return;
  try {
    const res = await fetch("/replays?x=" + Date.now(), { cache: "no-store" });
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) {
      container.innerHTML = "<div style='padding:10px;text-align:center;color:#546e7a;font-size:11px'>No saved replays found in m2/replays</div>";
      return;
    }
    container.innerHTML = list.map(item => {
      const dur = item.duration ? `${parseFloat(item.duration).toFixed(0)}s` : "";
      const kb = Math.round(item.size / 1024);
      const sizeStr = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
      return `
        <div class="replay-item" data-file="${item.file}">
          <div style="flex:1;min-width:0;margin-right:8px">
            <div style="font-weight:bold;color:#eceff1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.file}</div>
            <div class="replay-item-meta">${dur ? dur + " | " : ""}${sizeStr} <span style="color:#4db6ac"></span></div>
          </div>
          <button class="btn-pill load-btn" style="font-size:10px;white-space:nowrap">Load</button>
        </div>
      `;
    }).join("");

    container.querySelectorAll(".replay-item").forEach(el => {
      el.onclick = async () => {
        const file = el.dataset.file;
        const btn = el.querySelector(".load-btn");
        const prevText = btn ? btn.textContent : "Load";
        if (btn) {
          btn.textContent = "( ´･ω･) slimming...";
          btn.style.opacity = "0.7";
        }
        try {
          const t0 = performance.now();
          const r = await fetch(`/replay.json?file=${encodeURIComponent(file)}`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const d = await r.json();
          const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
          engine.load(d);
          container.querySelectorAll(".replay-item").forEach(x => x.classList.remove("active"));
          el.classList.add("active");
          if (btn) btn.textContent = `[ok] ${elapsed}s (・∀・)`;
        } catch (e) {
          alert("Failed to load server replay: " + e.message);
          if (btn) btn.textContent = prevText;
        } finally {
          if (btn) btn.style.opacity = "1";
        }
      };
    });
  } catch (err) {
    container.innerHTML = "<div style='padding:10px;text-align:center;color:#ef5350;font-size:11px'>Error fetching server replays</div>";
  }
}

function loadDemoMatch() {
  const heroRoster = [
    { g: 101, id: 111, camp: 1, ally: 1, hn: "Edith", p: [-30, 0, -20] },
    { g: 102, id: 17, camp: 1, ally: 1, hn: "Fanny", p: [-10, 0, -10] },
    { g: 103, id: 6, camp: 1, ally: 1, hn: "Tigreal", p: [-20, 0, 0] },
    { g: 104, id: 53, camp: 1, ally: 1, hn: "Lesley", p: [-35, 0, 15] },
    { g: 105, id: 115, camp: 1, ally: 1, hn: "Xavier", p: [-5, 0, -5] },
    { g: 201, id: 84, camp: 2, ally: 0, hn: "Ling", p: [15, 0, 15] },
    { g: 202, id: 119, camp: 2, ally: 0, hn: "Novaria", p: [5, 0, 5] },
    { g: 203, id: 10, camp: 2, ally: 0, hn: "Franco", p: [25, 0, -10] },
    { g: 204, id: 31, camp: 2, ally: 0, hn: "Moskov", p: [35, 0, -25] },
    { g: 205, id: 82, camp: 2, ally: 0, hn: "Terizla", p: [10, 0, 30] }
  ];

  const frames = [];
  for (let i = 0; i < 250; i++) {
    const t = i * 0.15;
    const heroes = heroRoster.map((h, idx) => {
      const angle = (t * 0.2) + (idx * 0.6);
      const rad = 10 + (idx * 3.5);
      const isFog = (i > 40 && i < 180) && (h.camp === 2);
      return {
        g: h.g,
        id: h.id,
        camp: h.camp,
        ally: h.ally,
        fog: isFog ? 1 : 0,
        hn: h.hn,
        p: [
          h.p[0] + Math.sin(angle) * (rad * 0.4),
          0,
          h.p[2] + Math.cos(angle) * (rad * 0.4)
        ],
        hp: Math.max(200, 3500 - (i * 8)),
        hm: 4000,
        sk: [0, 0, (i % 30 < 10 ? 15 : 0), 0],
        sp: (i > 80 && i < 160 && h.hn === "Edith") ? 45 : 0
      };
    });

    const jungle = [
      { id: 2003, p: [0, 0, 5], hp: Math.max(0, 12000 - i * 50), hm: 12000, death: i > 220 },
      { id: 2005, p: [-18, 0, -15], hp: 3500, hm: 3500, death: false },
      { id: 2004, p: [18, 0, 15], hp: 3500, hm: 3500, death: false }
    ];

    frames.push({
      gt: t,
      bm: 1,
      self: heroes[0],
      heroes: heroes,
      jungle: jungle
    });
  }

  const demoReplay = {
    version: 1,
    matchId: "demo_match_Edith",
    recordedAt: new Date().toISOString(),
    selfCamp: 1,
    duration: 37.5,
    draft: heroRoster,
    frames: frames
  };

  engine.load(demoReplay);
}

// ---------------- Picture-in-Picture Support ----------------
let pipVideo = null;
function initPip() {
  if (pipVideo) return pipVideo;
  const canvas = $("map");
  if (!canvas) return null;
  const getStream = canvas.captureStream || canvas.webkitCaptureStream;
  if (!getStream) return null;

  pipVideo = document.createElement("video");
  pipVideo.muted = true;
  pipVideo.playsInline = true;
  pipVideo.autoplay = true;
  pipVideo.style.cssText = "position:fixed;width:1px;height:1px;opacity:0.001;pointer-events:none;top:0;left:0;";
  document.body.appendChild(pipVideo);
  pipVideo.srcObject = getStream.call(canvas, 60);
  pipVideo.play().catch(() => { });
  return pipVideo;
}

function bindRecorderUI() {
  const btnRecStart = $("btn-rec-start");
  if (btnRecStart) btnRecStart.onclick = startLiveRecord;

  const btnRecStop = $("btn-rec-stop");
  if (btnRecStop) btnRecStop.onclick = stopLiveRecord;

  const btnRefresh = $("btn-refresh-server");
  if (btnRefresh) btnRefresh.onclick = e => { e.preventDefault(); loadServerReplays(); };

  const btnDemo = $("btn-demo");
  if (btnDemo) btnDemo.onclick = loadDemoMatch;

  const btnOpenFile = $("btn-open-file");
  const fileInput = $("file-input");
  if (btnOpenFile && fileInput) {
    btnOpenFile.onclick = () => fileInput.click();
    fileInput.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const data = JSON.parse(ev.target.result);
          engine.load(data);
        } catch (err) {
          alert("Error parsing .mreplay JSON: " + err.message);
        }
      };
      reader.readAsText(file);
    };
  }

  const btnExport = $("btn-export");
  if (btnExport) {
    btnExport.onclick = () => {
      if (!engine.replay) return;
      const blob = new Blob([JSON.stringify(engine.replay, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (engine.replay.matchId || "match") + ".mreplay";
      a.click();
      URL.revokeObjectURL(url);
    };
  }

  const bPip = $("b_pip");
  if (bPip) {
    bPip.onclick = () => {
      const vid = initPip();
      if (!vid) { alert("Picture-in-Picture not supported"); return; }
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => { });
      } else if (vid.requestPictureInPicture) {
        vid.requestPictureInPicture().catch(e => alert("PiP Error: " + e.message));
      }
    };
  }
}
