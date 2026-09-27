"use strict";

// ---------------- Replay Engine Core ----------------
class ReplayEngine {
  constructor() {
    this.replay = null;
    this.currentIdx = 0;
    this.isPlaying = false;
    this.speed = 1.0;
    this.lastTime = 0;
    this.loopTimeoutId = null;
  }

  load(data) {
    if (!data || !Array.isArray(data.frames) || data.frames.length === 0) {
      alert("Invalid replay file structure: no frames found.");
      return false;
    }
    this.replay = data;
    this.currentIdx = 0;
    this.isPlaying = false;

    // Set selfCamp
    if (data.selfCamp) selfCamp = data.selfCamp;
    else if (data.frames[0].self && data.frames[0].self.camp) selfCamp = data.frames[0].self.camp;

    const slider = $("timeSlider");
    if (slider) {
      slider.max = data.frames.length - 1;
      slider.value = 0;
    }
    const btnPlay = $("btn-play");
    if (btnPlay) btnPlay.textContent = "> Play";
    const btnExport = $("btn-export");
    if (btnExport) btnExport.disabled = false;

    const badge = $("matchBadge");
    if (badge) {
      badge.textContent = `${data.matchId || "Replay"} (${data.frames.length}f) (・∀・)`;
      badge.className = "badge live";
    }

    renderRoster(data.draft || (data.frames[0] ? data.frames[0].heroes : []));
    this.renderCurrentFrame();
    return true;
  }

  getCurrentFrame() {
    if (!this.replay || !this.replay.frames.length) return null;
    return this.replay.frames[this.currentIdx];
  }

  seek(idx) {
    if (!this.replay) return;
    this.currentIdx = Math.max(0, Math.min(idx, this.replay.frames.length - 1));
    const slider = $("timeSlider");
    if (slider) slider.value = this.currentIdx;
    this.renderCurrentFrame();
  }

  step(delta) {
    this.seek(this.currentIdx + delta);
  }

  setSpeed(s) {
    this.speed = s;
    if (this.isPlaying) {
      if (this.loopTimeoutId) clearTimeout(this.loopTimeoutId);
      const baseInterval = 150 / this.speed;
      this.loopTimeoutId = setTimeout(() => this.loop(), Math.max(10, baseInterval));
    }
  }

  togglePlay() {
    if (!this.replay) return;
    this.isPlaying = !this.isPlaying;
    const btnPlay = $("btn-play");
    if (btnPlay) btnPlay.textContent = this.isPlaying ? "|| Pause" : "> Play";
    if (this.isPlaying) {
      this.lastTime = performance.now();
      this.loop();
    } else {
      if (this.loopTimeoutId) clearTimeout(this.loopTimeoutId);
    }
  }

  loop() {
    if (!this.isPlaying) return;
    const now = performance.now();
    this.lastTime = now;

    const nextIdx = this.currentIdx + 1;

    if (nextIdx >= this.replay.frames.length) {
      const chkLoop = $("chk-loop");
      if (chkLoop && chkLoop.checked) {
        this.currentIdx = 0;
      } else {
        this.isPlaying = false;
        const btnPlay = $("btn-play");
        if (btnPlay) btnPlay.textContent = "> Play";
        return;
      }
    } else {
      this.currentIdx = nextIdx;
    }

    const slider = $("timeSlider");
    if (slider) slider.value = this.currentIdx;
    this.renderCurrentFrame();

    // Adjust timeout based on speed
    const baseInterval = 150 / this.speed;
    this.loopTimeoutId = setTimeout(() => this.loop(), Math.max(10, baseInterval));
  }

  renderCurrentFrame() {
    const f = this.getCurrentFrame();
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

    // Update readouts
    const gt = f.gt !== undefined ? f.gt : 0;
    const totalGt = this.replay.duration || (this.replay.frames[this.replay.frames.length - 1].gt || 0);

    const fmtTime = s => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    };

    if ($("timeReadout")) $("timeReadout").textContent = `${fmtTime(gt)} / ${fmtTime(totalGt)}`;
    if ($("hud-gt")) $("hud-gt").textContent = `gt: ${fmtTime(gt)} (${gt.toFixed(1)}s)`;
    if ($("hud-frame")) $("hud-frame").textContent = `frame: ${this.currentIdx + 1} / ${this.replay.frames.length}`;
    if ($("hud-side")) {
      $("hud-side").textContent = `Side: ${selfCamp === 2 ? "Red" : "Blue"}`;
      $("hud-side").style.color = selfCamp === 2 ? "#ef5350" : "#42a5f5";
    }
  }
}

const engine = new ReplayEngine();

function bindEngineControls() {
  const slider = $("timeSlider");
  if (slider) slider.oninput = e => engine.seek(parseInt(e.target.value));

  const btnPlay = $("btn-play");
  if (btnPlay) btnPlay.onclick = () => engine.togglePlay();

  const btnStart = $("btn-start");
  if (btnStart) btnStart.onclick = () => engine.seek(0);

  const btnEnd = $("btn-end");
  if (btnEnd) btnEnd.onclick = () => engine.seek(engine.replay ? engine.replay.frames.length - 1 : 0);

  const btnBack1 = $("btn-back1");
  if (btnBack1) btnBack1.onclick = () => engine.step(-7);

  const btnFwd1 = $("btn-fwd1");
  if (btnFwd1) btnFwd1.onclick = () => engine.step(7);

  const btnBack5 = $("btn-back5");
  if (btnBack5) btnBack5.onclick = () => engine.step(-35);

  const btnFwd5 = $("btn-fwd5");
  if (btnFwd5) btnFwd5.onclick = () => engine.step(35);

  const speedBtns = document.querySelectorAll("button[data-speed]");
  speedBtns.forEach(btn => {
    btn.onclick = () => {
      speedBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const spd = parseFloat(btn.dataset.speed);
      if (!isNaN(spd) && spd > 0) {
        engine.setSpeed(spd);
      }
    };
  });

  const btnOracle = $("btn-vis-oracle");
  const btnFog = $("btn-vis-fog");

  if (btnOracle && btnFog) {
    btnOracle.onclick = () => {
      visionMode = "oracle";
      btnOracle.classList.add("active");
      btnFog.classList.remove("active");
      if ($("hud-status")) $("hud-status").textContent = "Vision: Oracle (All Revealed)";
      engine.renderCurrentFrame();
    };

    btnFog.onclick = () => {
      visionMode = "fog";
      btnFog.classList.add("active");
      btnOracle.classList.remove("active");
      if ($("hud-status")) $("hud-status").textContent = "Vision: Player Vision (Fog of War)";
      engine.renderCurrentFrame();
    };
  }

  // Keyboard Shortcuts
  window.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space") {
      e.preventDefault();
      engine.togglePlay();
    } else if (e.code === "ArrowLeft") {
      e.preventDefault();
      engine.step(e.shiftKey ? -35 : -7);
    } else if (e.code === "ArrowRight") {
      e.preventDefault();
      engine.step(e.shiftKey ? 35 : 7);
    } else if (e.key === "f" || e.key === "F") {
      if (btnOracle && btnFog) {
        if (visionMode === "oracle") btnFog.click();
        else btnOracle.click();
      }
    } else if (e.key === "d" || e.key === "D") {
      if (typeof penTool !== "undefined") penTool.toggleActive();
    } else if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey)) {
      if (typeof penTool !== "undefined") penTool.undo();
    } else if (e.key === "[" || e.key === "]") {
      const allSpeedBtns = Array.from(document.querySelectorAll("button[data-speed]"));
      if (allSpeedBtns.length) {
        const curBtnIdx = allSpeedBtns.findIndex(b => parseFloat(b.dataset.speed) === engine.speed);
        let nextBtnIdx = e.key === "[" ? Math.max(0, curBtnIdx - 1) : Math.min(allSpeedBtns.length - 1, curBtnIdx + 1);
        allSpeedBtns[nextBtnIdx].click();
      }
    }
  });
}
