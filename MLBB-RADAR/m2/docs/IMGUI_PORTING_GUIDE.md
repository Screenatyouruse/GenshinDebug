# How-To Guide: Porting Dear ImGui to NightShift (Native Android Overlay)

**Author:** ENI & LO  
**Target:** Samsung Galaxy A35 (Exynos 1380 / Android 14 / One UI 6 / ARM64)  
**Objective:** Replace the Java `SFDaemon` (Skia CPU rasterizer) and JSON file-polling IPC with a unified, high-performance **Dear ImGui + OpenGL ES 3.0** native overlay.

---

## 1. Architectural Blueprint

### The Current Pipeline vs. The ImGui Vision

```text
CURRENT PIPELINE (Multi-Process & Java ART):
  [cppport / .audio_mixer] ──(stdout)──► [frame.json on UFS] ──(read/parse)──► [SFDaemon (Java/CPU)] ◄── [OverlayActivity]
                                                                                       │
                                                                           surface.lockCanvas() (CPU memset 10MB)

TARGET PIPELINE (Unified Native C++ Daemon):
  ┌────────────────────────────────────────────────────────────────────────┐
  │  nightshift_native (ARM64 Root Executable)                            │
  │                                                                        │
  │  ┌────────────────────────┐      Direct C++ Struct      ┌────────────┐ │
  │  │ Memory Reader Thread   │ ──────────────────────────► │ Render Loop│ │
  │  │ (process_vm_readv)     │  (Double-buffered in RAM)   │ (DearImGui)│ │
  │  └────────────────────────┘                             └─────┬──────┘ │
  └───────────────────────────────────────────────────────────────┼────────┘
                                                                  ▼
                                                      OpenGL ES 3.0 on SurfaceFlinger
                                                      (GPU hardware render < 0.3ms)
```

### Key Benefits
1. **Zero IPC & Zero JSON Overhead:** Entity data is read directly from memory into C++ structs and rendered on the next frame. No JSON serialization, no file writes, no disk thrashing.
2. **GPU Hardware Acceleration:** Renders via OpenGL ES 3.0 vertex buffers and shaders. Drawing 10 hero dots, avatars, and ESP boxes consumes < 1% CPU and < 0.3ms GPU time.
3. **Live In-Game Menu:** Provides a floating, draggable ImGui window directly on the screen to tune minimap offsets, sizes, colors, and toggles without ever leaving the game.

---

## 2. The Core Building Blocks

To build this yourself, you only need four main ingredients:

```text
nightshift_imgui/
├── jni/
│   ├── Android.mk                # Build script (links EGL, GLESv3, android, log)
│   ├── Application.mk            # ARM64-v8a target, C++20, NDK r25+
│   ├── main.cpp                  # Daemon entrypoint, EGL init, render loop
│   ├── reader.cpp / reader.h     # In-memory entity reader (adapted from cppport.cpp)
│   ├── surface_bridge.cpp        # SurfaceControl creation & touch pass-through
│   ├── imgui/                    # Dear ImGui submodule / source tree
│   │   ├── imgui.cpp
│   │   ├── imgui_draw.cpp
│   │   ├── imgui_tables.cpp
│   │   ├── imgui_widgets.cpp
│   │   └── backends/
│   │       ├── imgui_impl_opengl3.cpp
│   │       └── imgui_impl_opengl3.h
│   └── stb/
│       └── stb_image.h           # For fast hero avatar PNG texture loading
```

---

## 3. Step-by-Step Implementation Guide

### Step 1: SurfaceControl & The Native Window (`ANativeWindow`)

An overlay needs a native window buffer provided by Android's compositor (**SurfaceFlinger**).

#### Two Ways to Get an `ANativeWindow`:

1. **Option A: The Hybrid Launcher (Recommended for Android 14 Stability)**
   In Android 14 (One UI 6), the C++ ABI of private `libgui.so` symbols (`SurfaceComposerClient::createSurface`) varies across vendors. However, Java's `SurfaceControl.Builder` is rock-solid.
   - A tiny Java starter (run via `app_process`) creates the `SurfaceControl`, applies `setSkipScreenshot` and `setTrustedOverlay`, wraps it in an `android.view.Surface`, and passes it to your C++ native library via JNI:
     ```cpp
     #include <android/native_window_jni.h>
     ANativeWindow* nativeWindow = ANativeWindow_fromSurface(env, javaSurfaceObj);
     ```
   - This gives you an official NDK `ANativeWindow*` with 100% Android 14 compatibility.

2. **Option B: Pure Native `libgui.so` / Native Window**
   - You can dynamically resolve `SurfaceComposerClient` symbols via `dlopen("libgui.so", RTLD_NOW)` and `dlsym`. (Reference: [themaphack-main/jni/Tools/](file:///c:/Users/berni/Desktop/a35project/themaphack-main/jni/Tools/)).

---

### Step 2: Initialize OpenGL ES 3.0 with Transparent EGL Context

To render transparently over MLBB, EGL must be configured with an **8-bit alpha channel**:

```cpp
#include <EGL/egl.h>
#include <GLES3/gl3.h>

EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
eglInitialize(display, nullptr, nullptr);

// Configure 32-bit RGBA8888 with transparency
const EGLint attribs[] = {
    EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
    EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
    EGL_BLUE_SIZE, 8,
    EGL_GREEN_SIZE, 8,
    EGL_RED_SIZE, 8,
    EGL_ALPHA_SIZE, 8,
    EGL_NONE
};

EGLConfig config;
EGLint numConfigs;
eglChooseConfig(display, attribs, &config, 1, &numConfigs);

// Set native window format to match EGL RGBA_8888
ANativeWindow_setBuffersGeometry(nativeWindow, 0, 0, WINDOW_FORMAT_RGBA_8888);

EGLSurface surface = eglCreateWindowSurface(display, config, nativeWindow, nullptr);

const EGLint ctxAttribs[] = {
    EGL_CONTEXT_CLIENT_VERSION, 3,
    EGL_NONE
};
EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, ctxAttribs);

eglMakeCurrent(display, surface, surface, context);

// Enable alpha blending for clean transparency
glEnable(GL_BLEND);
glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
```

---

### Step 3: Initialize Dear ImGui

Once your EGL context is current, initialize Dear ImGui:

```cpp
#include "imgui.h"
#include "backends/imgui_impl_opengl3.h"

IMGUI_CHECKVERSION();
ImGui::CreateContext();
ImGuiIO& io = ImGui::GetIO();

// Display size (queried from ANativeWindow or DisplayInfo)
io.DisplaySize = ImVec2((float)screenWidth, (float)screenHeight);

// Set up ImGui style (dark/translucent theming fits game overlays best)
ImGui::StyleColorsDark();
ImGui::GetStyle().WindowRounding = 8.0f;
ImGui::GetStyle().Colors[ImGuiCol_WindowBg].w = 0.85f; // Translucent background

// Initialize OpenGL3 backend
ImGui_ImplOpenGL3_Init("#version 300 es");
```

#### Font Tip:
Load a crisp monospace font (like Consolas or Roboto) from an array in memory or from `/system/fonts/Roboto-Regular.ttf`:
```cpp
io.Fonts->AddFontFromFileTTF("/system/fonts/Roboto-Regular.ttf", 24.0f);
```

---

### Step 4: Touch Input Management (Passthrough vs. Menu)

A key lesson from [STEALTH_AND_INPUT_ARCH.md](file:///c:/Users/berni/Desktop/a35project/moba/m2/docs/STEALTH_AND_INPUT_ARCH.md):
- **When playing the game:** Touches must pass straight through to MLBB with zero latency.
- **When opening the ImGui settings window:** The overlay needs touch events so you can drag sliders and click buttons.

#### The Dual-Mode Input Strategy:
1. **SurfaceFlinger Window Flags:**
   - In passthrough mode: Assert `FLAG_NOT_TOUCHABLE (0x10) | FLAG_NOT_FOCUSABLE (0x8)` on the `InputWindowHandle`.
   - In menu mode: Clear `FLAG_NOT_TOUCHABLE` via `Transaction.setInputWindowInfo()` so touches route to your overlay.
2. **Feeding Touches to ImGui:**
   - When touches arrive on your native surface:
     ```cpp
     // In your touch callback:
     io.AddMousePosEvent(touchX, touchY);
     io.AddMouseButtonEvent(0, isActionDown);
     ```

---

### Step 5: Render Entities on Minimap Using `ImDrawList`

Instead of creating hundreds of Java `Paint`, `Path`, and `RectF` objects, ImGui provides **`ImDrawList`**, which buffers 2D GPU primitives directly.

Use `ImGui::GetBackgroundDrawList()` to draw full-screen overlay graphics behind any ImGui windows:

```cpp
ImDrawList* drawList = ImGui::GetBackgroundDrawList();

// 1. Draw radar bounding box
drawList->AddRect(
    ImVec2(mmStartX, mmStartY),
    ImVec2(mmStartX + mmSize, mmStartY + mmSize),
    IM_COL32(0, 220, 255, 180), // Color: RGBA
    16.0f,                      // Corner radius
    0, 2.5f                     // Thickness
);

// 2. Project world coordinates to minimap screen coordinates
// Constants from m2/docs/OVERLAY_MINIMAP_AND_W2S.md:
float angleRad = (isCamp2 ? 134.76f : 314.60f) * 0.0174532925f;
float cosA = cosf(angleRad);
float sinA = sinf(angleRad);
const float W_SPAN = 74.11f;

float rx = (cosA * hero.x - sinA * (-hero.z)) / W_SPAN;
float ry = (sinA * hero.x + cosA * (-hero.z)) / W_SPAN;

float screenX = rx * mmSize + mmStartX + (mmSize / 2.0f);
float screenY = ry * mmSize + mmStartY + (mmSize / 2.0f);

// 3. Draw hero dot / avatar
if (hero.isFog) {
    drawList->AddCircleFilled(ImVec2(screenX, screenY), dotRadius, IM_COL32(255, 160, 40, 200));
} else {
    drawList->AddCircleFilled(ImVec2(screenX, screenY), dotRadius, IM_COL32(255, 50, 50, 240));
}

// 4. Draw hero name
drawList->AddText(ImVec2(screenX + dotRadius + 4, screenY - 8), IM_COL32(255, 255, 255, 255), hero.name.c_str());
```

---

### Step 6: Texture Loading for Hero Icons (`stb_image`)

To render hero avatars smoothly:
1. Load PNGs from `/data/local/tmp/mlbbicons/<id>.png` using `stb_image.h`.
2. Generate an OpenGL 2D texture via `glGenTextures()` and `glTexImage2D()`.
3. Render using `ImDrawList::AddImage()`:
   ```cpp
   drawList->AddImage(
       (ImTextureID)(intptr_t)heroTextureId,
       ImVec2(screenX - dotRadius, screenY - dotRadius),
       ImVec2(screenX + dotRadius, screenY + dotRadius)
   );
   ```

---

### Step 7: The Main Frame Loop

Every frame runs in a clean, high-speed loop:

```cpp
while (isRunning) {
    // 1. Clear color buffer to fully transparent
    glClearColor(0.0f, 0.0f, 0.0f, 0.0f);
    glClear(GL_COLOR_BUFFER_BIT);

    // 2. Start ImGui frame
    ImGui_ImplOpenGL3_NewFrame();
    ImGui::NewFrame();

    // 3. Draw background radar & ESP
    RenderMinimapRadar(latestGameState);

    // 4. Draw optional floating settings window (when menu is toggled on)
    if (showMenu) {
        ImGui::Begin("NightShift MLBB", &showMenu, ImGuiWindowFlags_AlwaysAutoResize);
        ImGui::SliderFloat("Minimap X", &config.mmStartX, 0.0f, 300.0f);
        ImGui::SliderFloat("Minimap Y", &config.mmStartY, 0.0f, 300.0f);
        ImGui::SliderFloat("Minimap Size", &config.mmSize, 200.0f, 500.0f);
        ImGui::Checkbox("Show 3D Boxes", &config.showBoxes);
        ImGui::Checkbox("Show Tracers", &config.showTracers);
        ImGui::End();
    }

    // 5. Render ImGui draw lists via GLES3
    ImGui::Render();
    ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());

    // 6. Swap buffers (EGL automatically paces with display VSYNC!)
    eglSwapBuffers(display, surface);
}
```

---

## 4. Build Configuration (`Android.mk`)

Create an `Android.mk` inside `jni/` to build with the standard NDK:

```makefile
LOCAL_PATH := $(call my-dir)

include $(CLEAR_VARS)
LOCAL_MODULE    := nightshift_overlay

# Source files
LOCAL_SRC_FILES := main.cpp \
                   reader.cpp \
                   imgui/imgui.cpp \
                   imgui/imgui_draw.cpp \
                   imgui/imgui_tables.cpp \
                   imgui/imgui_widgets.cpp \
                   imgui/backends/imgui_impl_opengl3.cpp

# C++ flags
LOCAL_CPPFLAGS  := -std=c++20 -O3 -fvisibility=hidden

# System libraries
LOCAL_LDLIBS    := -llog -landroid -lEGL -lGLESv3

include $(BUILD_EXECUTABLE)
```

Compile with:
```cmd
ndk-build.cmd NDK_PROJECT_PATH=. APP_BUILD_SCRIPT=Android.mk APP_ABI=arm64-v8a APP_PLATFORM=android-34
```

---

## 5. Security & Stealth Checklist

Before running your native binary on the Galaxy A35, ensure you retain the proven stealth principles from [STEALTH_AND_INPUT_ARCH.md](file:///c:/Users/berni/Desktop/a35project/moba/m2/docs/STEALTH_AND_INPUT_ARCH.md):

1. **`setSkipScreenshot(true)`**: Always set flag `0x00000040` on your `SurfaceControl`. This excludes your ImGui overlay from system screenshots and screen recorders without triggering Knox security policy errors.
2. **`setTrustedOverlay(true)`**: Set on your `SurfaceControl` transaction so Android 12–14 touch dispatcher allows input passthrough without blocking untrusted touches.
3. **Core Pinning (`sched_setaffinity`)**: Keep the reader thread on Little cores (Cores 0 & 1), leaving the Cortex-A78 Big cores completely unhindered for MLBB.
4. **File Permissions**: Keep your compiled binary inside `/data/local/tmp/` with permissions `chmod 700` and owner `root:root`.
