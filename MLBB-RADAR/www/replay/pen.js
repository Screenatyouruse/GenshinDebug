"use strict";

// ---------------- Coaching Pen & Tactical Drawing Tool ----------------
class CoachingPen {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.isActive = false;
    this.mode = "pen"; // "pen" (freehand), "arrow", "line"
    this.color = "#42a5f5"; // default cyan
    this.lineWidth = 4;
    this.strokes = []; // Array of completed stroke objects for undo/history
    this.isDrawing = false;
    this.currentPoints = [];
    this.startPoint = null;
  }

  init(canvasElement) {
    this.canvas = canvasElement || $("penCanvas");
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext("2d");

    this.bindEvents();
    this.bindUI();
  }

  bindEvents() {
    const cv = this.canvas;

    cv.addEventListener("pointerdown", e => {
      if (!this.isActive) return;
      cv.setPointerCapture(e.pointerId);
      this.isDrawing = true;
      const pt = this.getCanvasPoint(e);
      this.startPoint = pt;
      this.currentPoints = [pt];
    });

    cv.addEventListener("pointermove", e => {
      if (!this.isActive || !this.isDrawing) return;
      const pt = this.getCanvasPoint(e);

      if (this.mode === "pen") {
        this.currentPoints.push(pt);
        this.redraw();
        this.drawFreehandStroke({
          points: this.currentPoints,
          color: this.color,
          lineWidth: this.lineWidth
        });
      } else if (this.mode === "arrow" || this.mode === "line") {
        this.redraw();
        if (this.mode === "arrow") {
          this.drawArrow(this.startPoint, pt, this.color, this.lineWidth);
        } else {
          this.drawLine(this.startPoint, pt, this.color, this.lineWidth);
        }
      }
    });

    const finishDraw = e => {
      if (!this.isActive || !this.isDrawing) return;
      this.isDrawing = false;
      const pt = this.getCanvasPoint(e);

      if (this.mode === "pen") {
        if (this.currentPoints.length > 1) {
          this.strokes.push({
            type: "pen",
            points: [...this.currentPoints],
            color: this.color,
            lineWidth: this.lineWidth
          });
        }
      } else if (this.mode === "arrow") {
        const dx = pt.x - this.startPoint.x;
        const dy = pt.y - this.startPoint.y;
        if (Math.hypot(dx, dy) > 5) {
          this.strokes.push({
            type: "arrow",
            start: this.startPoint,
            end: pt,
            color: this.color,
            lineWidth: this.lineWidth
          });
        }
      } else if (this.mode === "line") {
        const dx = pt.x - this.startPoint.x;
        const dy = pt.y - this.startPoint.y;
        if (Math.hypot(dx, dy) > 5) {
          this.strokes.push({
            type: "line",
            start: this.startPoint,
            end: pt,
            color: this.color,
            lineWidth: this.lineWidth
          });
        }
      }

      this.currentPoints = [];
      this.startPoint = null;
      this.redraw();
    };

    cv.addEventListener("pointerup", finishDraw);
    cv.addEventListener("pointercancel", finishDraw);
  }

  getCanvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }

  toggleActive(forceState) {
    this.isActive = typeof forceState === "boolean" ? forceState : !this.isActive;
    if (this.canvas) {
      if (this.isActive) {
        this.canvas.classList.add("active");
      } else {
        this.canvas.classList.remove("active");
        this.isDrawing = false;
      }
    }
    const btn = $("btn-pen-toggle");
    if (btn) {
      btn.classList.toggle("active", this.isActive);
      btn.textContent = this.isActive ? "Pen: ON _〆(・ω・ )" : "Pen: OFF (・_・)";
    }
  }

  setMode(mode) {
    this.mode = mode;
    document.querySelectorAll(".pen-mode-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
    if (!this.isActive) this.toggleActive(true);
  }

  setColor(color) {
    this.color = color;
    document.querySelectorAll(".pen-color-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.color === color);
    });
  }

  setLineWidth(w) {
    this.lineWidth = w;
    document.querySelectorAll(".pen-width-btn").forEach(b => {
      b.classList.toggle("active", parseInt(b.dataset.width) === w);
    });
  }

  undo() {
    if (this.strokes.length > 0) {
      this.strokes.pop();
      this.redraw();
    }
  }

  clear() {
    this.strokes = [];
    this.redraw();
  }

  redraw() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const s of this.strokes) {
      if (s.type === "pen") {
        this.drawFreehandStroke(s);
      } else if (s.type === "arrow") {
        this.drawArrow(s.start, s.end, s.color, s.lineWidth);
      } else if (s.type === "line") {
        this.drawLine(s.start, s.end, s.color, s.lineWidth);
      }
    }
  }

  drawFreehandStroke(s) {
    const pts = s.points;
    if (!pts || pts.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = 3;

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawLine(start, end, color, lineWidth) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = 3;

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.restore();
  }

  drawArrow(start, end, color, lineWidth) {
    const ctx = this.ctx;
    const headLen = Math.max(12, lineWidth * 3.5);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const angle = Math.atan2(dy, dx);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = 3;

    // Shaft
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(
      end.x - headLen * Math.cos(angle - Math.PI / 6),
      end.y - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      end.x - headLen * Math.cos(angle + Math.PI / 6),
      end.y - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  bindUI() {
    const btnToggle = $("btn-pen-toggle");
    if (btnToggle) btnToggle.onclick = () => this.toggleActive();

    const btnUndo = $("btn-pen-undo");
    if (btnUndo) btnUndo.onclick = () => this.undo();

    const btnClear = $("btn-pen-clear");
    if (btnClear) btnClear.onclick = () => this.clear();

    document.querySelectorAll(".pen-mode-btn").forEach(btn => {
      btn.onclick = () => this.setMode(btn.dataset.mode);
    });

    document.querySelectorAll(".pen-color-btn").forEach(btn => {
      btn.onclick = () => this.setColor(btn.dataset.color);
    });

    document.querySelectorAll(".pen-width-btn").forEach(btn => {
      btn.onclick = () => this.setLineWidth(parseInt(btn.dataset.width));
    });
  }
}

const penTool = new CoachingPen();
