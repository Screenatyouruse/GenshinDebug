"use strict";

// ---------------- Projection & Calibration ----------------
const W_ANGLE = 314.60 * Math.PI / 180;
const W_SPAN = 74.11;
const WC = Math.cos(W_ANGLE);
const WS = Math.sin(W_ANGLE);

const MAP_WIDTH = 720;
const MAP_HEIGHT = 720;
const CX = MAP_WIDTH / 2;
const CY = MAP_HEIGHT / 2;

function worldNorm(x, z) {
  const zz = -z;
  return [ (WC * x - WS * zz) / W_SPAN, (WS * x + WC * zz) / W_SPAN ];
}

const DEFP = {
  scale: 725.21,
  rot: 0.9,
  ox: -3,
  oy: 1,
  skscale: 1.8,
  iconsize: 21,
  dotsize: 6,
  flip: false
};

let profiles = Object.assign({ blue: Object.assign({}, DEFP), red: Object.assign({}, DEFP) },
                             JSON.parse(localStorage.getItem("mapprof") || "{}"));
profiles.blue = Object.assign({}, DEFP, profiles.blue);
profiles.red  = Object.assign({}, DEFP, profiles.red);

let selfCamp = 1;
const active = () => selfCamp === 2 ? profiles.red : profiles.blue;
const isFlipped = () => (selfCamp === 2) ? !active().flip : !!active().flip;

function saveP() {
  localStorage.setItem("mapprof", JSON.stringify(profiles));
}

function worldToScreen(x, z) {
  let [nx, ny] = worldNorm(x, z);
  const p = active();
  if (isFlipped()) { nx = -nx; ny = -ny; }
  const r = p.rot * Math.PI / 180;
  const rx = nx * Math.cos(r) - ny * Math.sin(r);
  const ry = nx * Math.sin(r) + ny * Math.cos(r);
  return [ CX + p.ox + rx * p.scale, CY + p.oy + ry * p.scale ];
}

function syncSliders() {
  const p = active();
  const sScale = $("s_scale");
  if (!sScale) return;
  sScale.value = p.scale;
  $("v_scale").textContent = (+p.scale).toFixed(2);
  $("s_rot").value = p.rot;
  $("v_rot").textContent = (+p.rot).toFixed(1) + "°";
  $("s_ox").value = p.ox;
  $("v_ox").textContent = (+p.ox).toFixed(0);
  $("s_oy").value = p.oy;
  $("v_oy").textContent = (+p.oy).toFixed(0);
  $("s_iconsize").value = p.iconsize;
  $("v_iconsize").textContent = p.iconsize + " px";
  $("s_dotsize").value = p.dotsize;
  $("v_dotsize").textContent = (+p.dotsize).toFixed(1) + " px";
  if ($("btn-flip")) {
    $("btn-flip").classList.toggle("on", isFlipped());
  }
}

function initCalibrationUI(renderCallback) {
  function bindSlider(id, key, fmt) {
    const el = $("s_" + id);
    if (!el) return;
    el.oninput = () => {
      active()[key] = parseFloat(el.value);
      $("v_" + id).textContent = fmt(active()[key]);
      saveP();
      if (renderCallback) renderCallback();
    };
  }
  bindSlider("scale", "scale", v => (+v).toFixed(2));
  bindSlider("rot", "rot", v => (+v).toFixed(1) + "°");
  bindSlider("ox", "ox", v => (+v).toFixed(0));
  bindSlider("oy", "oy", v => (+v).toFixed(0));
  bindSlider("iconsize", "iconsize", v => (+v).toFixed(0) + " px");
  bindSlider("dotsize", "dotsize", v => (+v).toFixed(1) + " px");

  const btnFlip = $("btn-flip");
  if (btnFlip) {
    btnFlip.onclick = () => {
      const p = active();
      p.flip = !p.flip;
      saveP();
      syncSliders();
      if (renderCallback) renderCallback();
    };
  }
  syncSliders();
}
