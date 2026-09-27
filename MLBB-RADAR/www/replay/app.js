"use strict";

// ---------------- Application Entrypoint ----------------
window.addEventListener("DOMContentLoaded", () => {
  // 1. Initialize minimap renderer with the primary map canvas
  initRenderer($("map"));

  // 2. Initialize coaching pen overlay
  penTool.init($("penCanvas"));

  // 3. Initialize calibration UI and bind slider listeners
  initCalibrationUI(() => engine.renderCurrentFrame());

  // 4. Bind playback engine controls, speed buttons, and keyboard shortcuts
  bindEngineControls();

  // 5. Bind live recorder, server replay manager, local file loaders, and PiP
  bindRecorderUI();

  // 6. Fetch saved replays from server (/replays)
  loadServerReplays();

  // 7. Auto-load realistic demo match on start
  loadDemoMatch();
});
