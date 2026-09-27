/**
 * User controls, settings panel bindings, canvas mouse drag/zoom, touch gestures, and two-click base calibration.
 */
import { state, getActiveProfile, getProfileName, saveProfiles, resetActiveProfile, setDebugMode } from "./state.js";
import { calibrateProfile, isFlipped } from "./coords.js";
import { setCustomMapImage } from "./renderer.js";

export function initControls(elements, onProfileChange) {
  const {
    cv, panel, toggleBtn, profName, mapfile,
    sScale, vScale, sRot, vRot, sOx, vOx, sOy, vOy,
    sSkscale, vSkscale, sIconsize, vIconsize,
    bFlip, bGrid, bDbg, bGank, bVoice, bConf, bConfHud, confDebugPanel, cdClose,
    bHsm, cdHsmLogBtn, cdHsmClrBtn,
    bFps,
    bReset, bCal1, bCal2, calStatus
  } = elements;

  function syncSliders() {
    const p = getActiveProfile();
    if (p.skscale === undefined) p.skscale = 1.8;
    if (p.iconsize === undefined) p.iconsize = 21;

    sScale.value = p.scale;
    vScale.textContent = (+p.scale).toFixed(2) + " px/u";

    sRot.value = p.rot;
    vRot.textContent = (+p.rot).toFixed(1) + "°";

    sOx.value = p.ox;
    vOx.textContent = (+p.ox).toFixed(0);

    sOy.value = p.oy;
    vOy.textContent = (+p.oy).toFixed(0);

    sSkscale.value = p.skscale;
    vSkscale.textContent = (+p.skscale).toFixed(1) + "x";

    sIconsize.value = p.iconsize;
    vIconsize.textContent = (+p.iconsize).toFixed(0) + " px";

    profName.textContent = getProfileName();
    profName.style.color = (state.selfCamp === 2) ? "var(--accent-red)" : "var(--accent-teal)";

    bGrid.classList.toggle("on", state.showGrid);
    bGrid.textContent = "grid: " + (state.showGrid ? "on" : "off");

    bDbg.classList.toggle("on", state.debugMode);
    bDbg.textContent = "debug: " + (state.debugMode ? "on" : "off");

    const gankOn = localStorage.getItem("mapgankalert") !== "0";
    if (bGank) {
      bGank.classList.toggle("on", gankOn);
      bGank.textContent = "gank alert: " + (gankOn ? "on" : "off");
    }

    const voiceOn = localStorage.getItem("mapgankvoice") !== "0";
    if (bVoice) {
      bVoice.classList.toggle("on", voiceOn);
      bVoice.textContent = "gank voice: " + (voiceOn ? "on" : "off");
      bVoice.style.display = gankOn ? "inline-block" : "none";
    }

    const confOn = localStorage.getItem("mapgankconfdbg") === "1";
    if (bConf) {
      bConf.classList.toggle("on", confOn);
      bConf.textContent = "conf states: " + (confOn ? "on" : "off");
    }
    if (bConfHud) {
      bConfHud.classList.toggle("active", confOn);
    }
    if (confDebugPanel) {
      confDebugPanel.classList.toggle("hidden", !confOn);
    }

    const hsmLogOn = localStorage.getItem("mapgankhsmlog") === "1";
    if (bHsm) {
      bHsm.classList.toggle("on", hsmLogOn);
      bHsm.textContent = "hsm log: " + (hsmLogOn ? "on" : "off");
    }
    if (cdHsmLogBtn) {
      cdHsmLogBtn.classList.toggle("active", hsmLogOn);
      cdHsmLogBtn.classList.toggle("safe", !hsmLogOn);
      cdHsmLogBtn.textContent = "LOG: " + (hsmLogOn ? "ON" : "OFF");
    }

    const fpsVal = localStorage.getItem("mapfps") || "60";
    if (bFps) {
      bFps.textContent = "fps: " + (fpsVal === "0" ? "max" : fpsVal);
      bFps.classList.toggle("on", fpsVal !== "0");
    }
  }

  function bindSlider(sliderEl, valEl, key, formatFn) {
    sliderEl.addEventListener("input", () => {
      const p = getActiveProfile();
      p[key] = parseFloat(sliderEl.value);
      valEl.textContent = formatFn(p[key]);
      saveProfiles();
      if (onProfileChange) onProfileChange();
    });
  }

  bindSlider(sScale, vScale, "scale", v => (+v).toFixed(2) + " px/u");
  bindSlider(sRot, vRot, "rot", v => (+v).toFixed(1) + "°");
  bindSlider(sOx, vOx, "ox", v => (+v).toFixed(0));
  bindSlider(sOy, vOy, "oy", v => (+v).toFixed(0));
  bindSlider(sSkscale, vSkscale, "skscale", v => (+v).toFixed(1) + "x");
  bindSlider(sIconsize, vIconsize, "iconsize", v => (+v).toFixed(0) + " px");

  bFlip.addEventListener("click", () => {
    const p = getActiveProfile();
    p.rot = (p.rot + 180) % 360;
    if (p.rot > 180) p.rot -= 360;
    if (p.rot < -180) p.rot += 360;
    saveProfiles();
    syncSliders();
    if (onProfileChange) onProfileChange();
  });

  bGrid.addEventListener("click", () => {
    state.showGrid = !state.showGrid;
    syncSliders();
    if (onProfileChange) onProfileChange();
  });

  bDbg.addEventListener("click", () => {
    setDebugMode(!state.debugMode);
    syncSliders();
    if (onProfileChange) onProfileChange();
  });

  bReset.addEventListener("click", () => {
    resetActiveProfile();
    syncSliders();
    if (onProfileChange) onProfileChange();
  });

  if (bGank) {
    bGank.addEventListener("click", () => {
      const current = localStorage.getItem("mapgankalert") !== "0";
      localStorage.setItem("mapgankalert", current ? "0" : "1");
      syncSliders();
    });
  }

  if (bVoice) {
    bVoice.addEventListener("click", () => {
      const current = localStorage.getItem("mapgankvoice") !== "0";
      localStorage.setItem("mapgankvoice", current ? "0" : "1");
      syncSliders();
      if (!current && "speechSynthesis" in window) {
        try {
          const testMsg = new SpeechSynthesisUtterance("Gank voice alert enabled");
          testMsg.rate = 1.25;
          window.speechSynthesis.speak(testMsg);
        } catch (e) {}
      }
    });
  }

  function toggleConfDebug() {
    const current = localStorage.getItem("mapgankconfdbg") === "1";
    localStorage.setItem("mapgankconfdbg", current ? "0" : "1");
    syncSliders();
    if (onProfileChange) onProfileChange();
  }

  if (bConf) bConf.addEventListener("click", toggleConfDebug);
  if (bConfHud) bConfHud.addEventListener("click", toggleConfDebug);
  if (cdClose) cdClose.addEventListener("click", toggleConfDebug);

  function toggleHsmLog() {
    const current = localStorage.getItem("mapgankhsmlog") === "1";
    const next = !current;
    localStorage.setItem("mapgankhsmlog", next ? "1" : "0");
    if (typeof window.setHSMDebug === "function") {
      window.setHSMDebug({ enabled: next, logConsole: next });
    }
    syncSliders();
  }

  if (bHsm) bHsm.addEventListener("click", toggleHsmLog);
  if (cdHsmLogBtn) cdHsmLogBtn.addEventListener("click", toggleHsmLog);
  if (cdHsmClrBtn) {
    cdHsmClrBtn.addEventListener("click", () => {
      if (typeof window.clearHSMHistory === "function") {
        window.clearHSMHistory();
      }
      if (onProfileChange) onProfileChange();
    });
  }

  if (bFps) {
    bFps.addEventListener("click", () => {
      const current = localStorage.getItem("mapfps") || "60";
      const next = current === "60" ? "30" : (current === "30" ? "0" : "60");
      localStorage.setItem("mapfps", next);
      syncSliders();
      if (typeof window.setTargetFps === "function") {
        window.setTargetFps(parseInt(next, 10));
      }
    });
  }

  // Restore initial HSM log config
  if (localStorage.getItem("mapgankhsmlog") === "1") {
    if (typeof window.setHSMDebug === "function") {
      window.setHSMDebug({ enabled: true, logConsole: true });
    }
  }

  toggleBtn.addEventListener("click", () => {
    panel.classList.toggle("hidden");
  });

  mapfile.addEventListener("change", ev => {
    const file = ev.target.files[0];
    if (!file) return;
    setCustomMapImage(file, state.selfCamp === 2);
    if (onProfileChange) onProfileChange();
  });

  // Two-click base calibration
  let calStep = 0;
  let calQ1 = null;

  function getCanvasPoint(ev) {
    const rect = cv.getBoundingClientRect();
    return [
      (ev.clientX - rect.left) * (cv.width / rect.width),
      (ev.clientY - rect.top) * (cv.height / rect.height)
    ];
  }

  cv.addEventListener("click", ev => {
    if (!calStep) return;
    const pt = getCanvasPoint(ev);

    if (calStep === 1) {
      calQ1 = pt;
      calStep = 2;
      calStatus.textContent = "My base set — now click the ENEMY base icon";
    } else if (calStep === 2) {
      const p = calibrateProfile(calQ1, pt, cv.width / 2, cv.height / 2);
      saveProfiles();
      syncSliders();
      calStep = 0;
      calStatus.textContent = `Calibrated ✓ (scale: ${p.scale.toFixed(2)}, rot: ${p.rot.toFixed(1)}°)`;
      if (onProfileChange) onProfileChange();
    }
  });

  bCal1.addEventListener("click", () => {
    calStep = 1;
    calStatus.textContent = "Click YOUR base icon on the map...";
  });

  bCal2.addEventListener("click", () => {
    calStep = 2;
    calStatus.textContent = "Click the ENEMY base icon on the map...";
  });

  // Mouse Drag / Pan & Wheel Zoom
  let dragging = false;
  let dragStart = null;

  cv.addEventListener("mousedown", ev => {
    if (calStep) return;
    dragging = true;
    const p = getActiveProfile();
    dragStart = { x: ev.clientX, y: ev.clientY, ox: p.ox, oy: p.oy };
  });

  window.addEventListener("mouseup", () => { dragging = false; });

  window.addEventListener("mousemove", ev => {
    if (!dragging || calStep) return;
    const p = getActiveProfile();
    const rect = cv.getBoundingClientRect();
    const k = cv.width / rect.width;
    p.ox = dragStart.ox + (ev.clientX - dragStart.x) * k;
    p.oy = dragStart.oy + (ev.clientY - dragStart.y) * k;
    syncSliders();
    saveProfiles();
    if (onProfileChange) onProfileChange();
  });

  cv.addEventListener("wheel", ev => {
    ev.preventDefault();
    const p = getActiveProfile();
    if (ev.ctrlKey) {
      p.rot += (ev.deltaY > 0 ? -1 : 1);
    } else {
      p.scale *= (ev.deltaY > 0 ? 0.95 : 1.05);
    }
    saveProfiles();
    syncSliders();
    if (onProfileChange) onProfileChange();
  }, { passive: false });

  // Touch Support for Mobile / Tablet via Tailscale
  let touchStartDist = 0;
  let touchInitialScale = 0;

  cv.addEventListener("touchstart", ev => {
    if (calStep) return;
    const p = getActiveProfile();

    if (ev.touches.length === 1) {
      dragging = true;
      dragStart = {
        x: ev.touches[0].clientX,
        y: ev.touches[0].clientY,
        ox: p.ox,
        oy: p.oy
      };
    } else if (ev.touches.length === 2) {
      dragging = false;
      touchStartDist = Math.hypot(
        ev.touches[0].clientX - ev.touches[1].clientX,
        ev.touches[0].clientY - ev.touches[1].clientY
      );
      touchInitialScale = p.scale;
    }
  }, { passive: true });

  cv.addEventListener("touchmove", ev => {
    if (calStep) return;
    const p = getActiveProfile();
    const rect = cv.getBoundingClientRect();
    const k = cv.width / rect.width;

    if (ev.touches.length === 1 && dragging && dragStart) {
      p.ox = dragStart.ox + (ev.touches[0].clientX - dragStart.x) * k;
      p.oy = dragStart.oy + (ev.touches[0].clientY - dragStart.y) * k;
      syncSliders();
      saveProfiles();
      if (onProfileChange) onProfileChange();
    } else if (ev.touches.length === 2 && touchStartDist > 0) {
      const dist = Math.hypot(
        ev.touches[0].clientX - ev.touches[1].clientX,
        ev.touches[0].clientY - ev.touches[1].clientY
      );
      const ratio = dist / touchStartDist;
      p.scale = touchInitialScale * ratio;
      syncSliders();
      saveProfiles();
      if (onProfileChange) onProfileChange();
    }
  }, { passive: true });

  cv.addEventListener("touchend", () => {
    dragging = false;
    touchStartDist = 0;
  });

  // Initial sync
  syncSliders();

  return { syncSliders };
}
