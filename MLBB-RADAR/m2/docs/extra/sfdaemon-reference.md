# NightShift SFDaemon.java — Annotated Reference

> Complete walkthrough of SFDaemon internals as understood from context.
> Last updated: 2026-09-21

---

## Class Structure

```java
package com.lumen.nightshift;

// Key imports
import android.graphics.*;          // Canvas, Paint, Bitmap, Color, Path, RectF, PorterDuff
import android.view.Surface;
import android.os.IBinder;
import android.view.PixelFormat;
import android.graphics.Region;
import java.io.*;
import java.net.*;
import java.util.*;
import org.json.*;

public class SFDaemon {
    static volatile boolean running = true;
    
    // Constants
    static final float VPW = 2340f;           // Virtual viewport width
    static final float VPH = 1080f;           // Virtual viewport height
    static final float W_SPAN = 180f;         // World coordinate range for minimap
    static final float W_ANGLE_CAMP1 = 314.60f;  // Blue side rotation angle
    static final float W_ANGLE_CAMP2 = 134.76f;  // Red side rotation angle (180° flip)
    static final float RAD = (float)(Math.PI / 180.0);
    
    public static void main(String[] args) { ... }
    private static String readString(File f) { ... }
}
```

---

## Initialization Sequence

### 1. Display Detection (Reflection)

```java
// Get physical display token
Class<?> scClass = Class.forName("android.view.SurfaceControl");
Method getPhysicalDisplayToken = scClass.getMethod("getPhysicalDisplayToken", long.class);
IBinder displayToken = (IBinder) getPhysicalDisplayToken.invoke(null, 0L);

// Get display size from active mode
// → Results in bufW=2340, bufH=1080, hz=60.0
// → frameSleepMs = (long)(1000f / hz) = 17
```

### 2. SurfaceControl Creation (Reflection)

All done via reflection because these are @hide APIs:

```java
// Builder pattern
SurfaceControl.Builder → setName("NightShift_SF")
                       → setBufferSize(2340, 1080)
                       → setFormat(RGBA_8888)
                       → build()

// Transaction
Transaction → setLayer(sc, 0x7FFFFFFF)           // topmost layer
           → setSecure(sc, true)                  // invisible to screenshots
           → setTrustedOverlay(sc, true)          // bypass touch blocking
           → setInputWindowInfo(sc, iwh)          // NOT_TOUCHABLE | NOT_FOCUSABLE
           → show(sc)
           → apply()
```

### 3. Paint Objects

| Paint | Style | Color | Purpose |
|-------|-------|-------|---------|
| `boxEnemy` | STROKE 3.5f | rgba(255,60,60,240) | ESP box (visible enemy) |
| `boxFog` | STROKE 3.5f | rgba(255,170,50,200) | ESP box (fog enemy) |
| `tracerPaint` | STROKE 1.8f | rgba(255,70,70,160) | Tracer lines |
| `dotEnemy` | FILL | rgba(255,50,50,240) | Minimap dot (enemy) |
| `dotFog` | FILL | rgba(255,160,40,200) | Minimap dot (fog) |
| `dotBuffRed` | FILL | rgba(255,100,30,240) | Red buff |
| `dotBuffBlue` | FILL | rgba(140,60,255,240) | Blue buff |
| `dotObjective` | FILL | rgba(255,215,0,250) | Lord/Turtle (gold) |
| `dotSelf` | FILL | rgba(60,150,255,255) | Self (blue) |
| `dotSelfRing` | STROKE 2.5f | WHITE | Self ring |
| `textP` | - | WHITE, 26f | Text with shadow |
| `badgeBg` | FILL | rgba(20,20,25,160) | Status badge background |
| `radarBorder` | STROKE 2.5f | rgba(0,220,255,180) | Minimap border (cyan) |
| `hpBg` | FILL | rgba(30,30,30,200) | HP bar background |
| `hpFg` | FILL | rgba(80,200,90,220) | HP bar foreground |
| `iconRingPaint` | STROKE 2.5f, AA | varies | Hero icon ring |

---

## Main Render Loop

```
while (running) {
    1. Check stop_sf sentinel file
    2. Poll prefs.json for config changes (by lastModified)
    3. Select freshest data source (HTTP vs local file)
    4. lockCanvas → clear → parse JSON → render → unlockCanvasAndPost
    5. Thread.sleep(frameSleepMs)
}
```

### Data Source Selection Logic

```
                    ┌──────────────┐
                    │ httpAge < 3.5s │
                    │ AND fresher?  │
                    └───┬──────┬───┘
                    YES │      │ NO
                        ▼      │
               ┌────────────┐  │
               │ Use HTTP   │  │
               │ cachedJson │  │    ┌──────────────┐
               └────────────┘  ├───►│ fileAge < 3.5s │
                               │    └───┬──────┬───┘
                               │    YES │      │ NO
                               │        ▼      ▼
                               │  ┌──────────┐ ┌──────────┐
                               │  │Use local │ │ cachedJson│
                               │  │frame.json│ │ = ""      │
                               │  └──────────┘ │ (STANDBY) │
                               │               └──────────┘
```

### Frame Latch (Anti-Flicker)

```java
// After JSON parse attempt:
if (root != null && root.optInt("bm", 0) == 1) {
    lastValidRoot = root;      // save good frame
    lastValidBmTime = now;     // timestamp it
    bm = 1;
} else if (now - lastValidBmTime < 400 && lastValidRoot != null) {
    root = lastValidRoot;      // reuse last good frame for up to 400ms
    bm = 1;                    // keep showing BATTLE
}
// else: bm stays 0, shows STANDBY (only after 400ms of no valid data)
```

---

## Rendering Pipeline (per frame, when bm==1)

### 1. Status Badge
```
┌─────────────────────────────────┐
│  NightShift [BATTLE]  (green)   │  ← bm==1, local
│  NightShift [LIVE-NET] (bright) │  ← bm==1, HTTP
│  NightShift [STANDBY] (cyan)    │  ← bm==0, local
│  NightShift [NET-IDLE] (cyan)   │  ← bm==0, HTTP
└─────────────────────────────────┘
```

### 2. Enemy Heroes on Minimap
For each hero in `heroes[]` where `ally != 1` and `guid != selfGuid`:
- Transform world pos → minimap coords (with camp-aware rotation)
- Clip bounds to minimap rect
- Load hero icon from `/data/local/tmp/mlbbicons/<id>.png` (cached)
- Draw circular-clipped icon OR colored dot (if no icon)
- Ring color: RED (visible) or ORANGE (fog)

### 3. ESP Boxes (if showBoxes)
Screen-space boxes using `sx`/`sy` scale factors:
```java
float x0 = wx * sx, y0 = wz * sy;  // (approximate, actual uses pos array)
cv.drawRect(x0, y0, x1, y1, fog ? boxFog : boxEnemy);
```

### 4. HP Bars (if showHp)
```java
float r = hm > 0 ? Math.max(0f, Math.min(1f, hp / (float) hm)) : 0f;
cv.drawRect(x0, y0 - 10, x1, y0 - 4, hpBg);
cv.drawRect(x0, y0 - 10, x0 + (x1 - x0) * r, y0 - 4, hpFg);
```

### 5. Hero Names (if showNames)
```java
String nm = h.optString("hn", "");
if (nm.length() == 0) nm = h.optString("n", "");
if (fog) nm += " *";
cv.drawText(nm, x0, y1 + 28, textP);
```

### 6. Self Dot on Minimap
- White ring + blue dot (fallback) or circular hero icon with white ring

### 7. Jungle Monsters (if showJungle)
Color-coded dots:
- `id == 2004` → Red buff (orange)
- `id == 2005` → Blue buff (purple)  
- `id == 2001/2002/2003` → Objectives (gold)

---

## HTTP Worker Thread

```java
Thread httpWorker = new Thread(() -> {
    while (running) {
        String u = activeHttpUrl[0];
        if (u != null && !u.isEmpty() && u.startsWith("http")) {
            URL url = new URL(u + "?t=" + System.currentTimeMillis()); // cache bust
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(800);
            conn.setReadTimeout(800);
            conn.setRequestProperty("User-Agent", "NightShift-SFDaemon/1.0");
            if (conn.getResponseCode() == 200) {
                synchronized (httpJsonHolder) {
                    httpJsonHolder[0] = responseBody;
                    lastHttpSuccess[0] = System.currentTimeMillis();
                }
            }
        }
        Thread.sleep(40); // ~25 polls/sec
    }
});
```

---

## readString() Helper

```java
private static String readString(File f) {
    StringBuilder sb = new StringBuilder();
    try (BufferedReader br = new BufferedReader(new FileReader(f))) {
        String line;
        while ((line = br.readLine()) != null) {
            sb.append(line);
        }
    } catch (Throwable ignored) {}
    return sb.toString();
}
```

**Note**: This reads the entire file. If `frame.json` is mid-write (truncated),
this returns partial/empty string. The frame latch handles this gracefully now.

---

## resolveHeroId() (Planned, may not be in live version yet)

Maps skin-variant IDs back to base hero IDs using the `hn` (hero name) field:

```java
private static int resolveHeroId(int rawId, String heroName) {
    // Check if icon exists for rawId
    File f = new File("/data/local/tmp/mlbbicons/" + rawId + ".png");
    if (f.exists()) return rawId;
    
    // Name-based fallback
    String name = heroName.toLowerCase().replaceAll("^(classic|bot|epic)\\s+", "");
    // Map known hero names → base IDs
    Map<String, Integer> nameMap = new HashMap<>();
    nameMap.put("chou", 26);
    nameMap.put("zilong", 16);
    // ... etc
    
    Integer baseId = nameMap.get(name);
    return baseId != null ? baseId : rawId;
}
```

This was designed but needs to be wired into the render loop:
```java
int hid = resolveHeroId(h.optInt("id", 0), h.optString("hn", ""));
int sid = resolveHeroId(self.optInt("id", 0), self.optString("hn", ""));
```
