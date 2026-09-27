import math
import tkinter as tk

# --- STATE CONFIG ---
WIDTH, HEIGHT = 1100, 480
BG_KEY = "#010101"  # Chroma-key color for transparency

func_type = "sin"   # 'sin' or 'cos'
amp = 2.0           # Amplitude (A)
period_pi = 4.0     # Period in multiples of pi (e.g. 4.0 = 4*pi)
phase_pi = -0.75    # Phase shift in multiples of pi (e.g. -0.75 = -3pi/4)
v_shift = 0.0       # Vertical baseline shift (D)

origin_x = WIDTH // 2
origin_y = HEIGHT // 2
pixels_per_pi = 90.0
pixels_per_unit = 40.0
show_grid = True

# --- WINDOW SETUP ---
root = tk.Tk()
root.title("ALEKS Trig Overlay")
root.geometry(f"{WIDTH}x{HEIGHT}+100+100")
root.overrideredirect(True)          # Borderless window
root.wm_attributes("-topmost", True) # Always on top
root.wm_attributes("-transparentcolor", BG_KEY)
root.config(bg=BG_KEY)

canvas = tk.Canvas(root, width=WIDTH, height=HEIGHT, bg=BG_KEY, highlightthickness=0)
canvas.pack(fill="both", expand=True)

# Dragging state
drag_data = {"x": 0, "y": 0, "orig_x": origin_x, "orig_y": origin_y}


def redraw():
    canvas.delete("all")

    # 1. Coordinate Grid
    if show_grid:
        canvas.create_line(0, origin_y, WIDTH, origin_y, fill="#666666", width=1)
        canvas.create_line(origin_x, 0, origin_x, HEIGHT, fill="#666666", width=1)
        for k in range(-12, 13):
            tx = origin_x + k * pixels_per_pi
            if 0 <= tx <= WIDTH:
                canvas.create_line(tx, origin_y - 6, tx, origin_y + 6, fill="#555555", width=1)

    # 2. Mathematical Sine / Cosine Wave
    B = (2.0 * math.pi) / (period_pi * math.pi)
    phase_rad = phase_pi * math.pi

    pts = []
    for sx in range(0, WIDTH, 2):
        x_math = (sx - origin_x) / (pixels_per_pi / math.pi)
        theta = B * (x_math - phase_rad)
        y_math = amp * (math.sin(theta) if func_type == "sin" else math.cos(theta)) + v_shift
        sy = origin_y - (y_math * pixels_per_unit)
        pts.extend([sx, sy])

    if len(pts) >= 4:
        canvas.create_line(pts, fill="#ffee00", width=3, smooth=True)

    # 3. Five Anchor Target Dots
    anchor_angles = [0.0, 0.5 * math.pi, math.pi, 1.5 * math.pi, 2.0 * math.pi]
    for angle in anchor_angles:
        x_m = (angle / B) + phase_rad
        y_m = amp * (math.sin(angle) if func_type == "sin" else math.cos(angle)) + v_shift
        pt_x = origin_x + x_m * (pixels_per_pi / math.pi)
        pt_y = origin_y - y_m * pixels_per_unit
        if 0 <= pt_x <= WIDTH and 0 <= pt_y <= HEIGHT:
            canvas.create_oval(pt_x - 7, pt_y - 7, pt_x + 7, pt_y + 7, fill="#ff2222", outline="#ffffff", width=2)

    # 4. HUD
    hud_lines = [
        f"Mode: {func_type.upper()} [Tab] | Amp: {amp:.2f} [UP/DN] | Vert: {v_shift:+.1f} [W/S]",
        f"Period: {period_pi:.2f}pi [L/R] | Shift: {phase_pi:+.2f}pi [A/D]",
        f"Scale: {pixels_per_pi:.0f}px/pi [Z/X] | {pixels_per_unit:.0f}px/unit [C/V] | Esc=Quit"
    ]
    for i, line in enumerate(hud_lines):
        canvas.create_text(16, 16 + i * 18, text=line, anchor="nw", fill="#00e5ff", font=("Consolas", 11, "bold"))


# --- EVENT HANDLERS ---
def on_key(event):
    global func_type, amp, period_pi, phase_pi, v_shift
    global pixels_per_pi, pixels_per_unit, show_grid

    k = event.keysym.lower()
    if k == "escape":
        root.destroy()
    elif k == "tab":
        func_type = "cos" if func_type == "sin" else "sin"
    elif k == "g":
        show_grid = not show_grid
    elif k == "up":
        amp += 0.25
    elif k == "down":
        amp = max(0.25, amp - 0.25)
    elif k == "right":
        period_pi += 0.25
    elif k == "left":
        period_pi = max(0.25, period_pi - 0.25)
    elif k == "d":
        phase_pi += 0.25
    elif k == "a":
        phase_pi -= 0.25
    elif k == "w":
        v_shift += 0.5
    elif k == "s":
        v_shift -= 0.5
    elif k == "x":
        pixels_per_pi += 2.0
    elif k == "z":
        pixels_per_pi = max(10.0, pixels_per_pi - 2.0)
    elif k == "v":
        pixels_per_unit += 2.0
    elif k == "c":
        pixels_per_unit = max(5.0, pixels_per_unit - 2.0)

    redraw()


def on_drag_start(event):
    drag_data["x"] = event.x_root
    drag_data["y"] = event.y_root
    # Drag the entire window around the screen
    drag_data["win_x"] = root.winfo_x()
    drag_data["win_y"] = root.winfo_y()


def on_drag_motion(event):
    dx = event.x_root - drag_data["x"]
    dy = event.y_root - drag_data["y"]
    root.geometry(f"+{drag_data['win_x'] + dx}+{drag_data['win_y'] + dy}")


canvas.bind("<Button-1>", on_drag_start)
canvas.bind("<B1-Motion>", on_drag_motion)
root.bind("<Key>", on_key)

redraw()
root.mainloop()