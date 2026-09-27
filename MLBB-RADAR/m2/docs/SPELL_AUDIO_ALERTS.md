# Future Feature Plan: Battle Spell Audio Alerts (TTS Voice Callouts)

**Author:** ENI & LO  
**Scope:** Browser Picture-in-Picture (`map.html` / `app.js`), `cppport.cpp` summon skill tracking, and Web Speech API synthesis.  
**Target Goal:** Announce enemy summon spells in real-time when cast (e.g., *"Silvanna Flicker"*, *"Franco Flicker"*, *"Tigreal Flicker"*, *"Ling Retribution"*).

---

## 1. Background & Trigger Logic

In `cppport.cpp`, each hero entity has two fields tracked for battle spells:
- `sm`: The summon skill ID (e.g., `20100` for **Flicker**, `20020` for **Retribution**, `20080` for **Purify**).
- `sp`: The remaining cooldown in seconds (`0` when ready, `> 0` when on cooldown).

When an enemy hero casts Flicker:
1. `sp` transitions from `0` (or `<= 0`) to `> 100` (Flicker base cooldown is 120s).
2. The trigger state machine detects `lastSp <= 0 && currentSp > 0`.
3. If `sm == 20100`, the spell is identified as **Flicker**.

---

## 2. Web Speech API (TTS) Architecture

The web frontend (`map.html` / `gank.js`) already includes speech synthesis infrastructure:

```javascript
const lastSpellCd = {}; // guid -> previous cd

function checkSpellUsed(hero) {
  if (hero.ally || !hero.sm || hero.sp === undefined) return;

  const prev = lastSpellCd[hero.g];
  lastSpellCd[hero.g] = hero.sp;

  // Spell just went on cooldown from ready
  if (prev !== undefined && prev <= 0 && hero.sp > 0) {
    const spellName = getSpellName(hero.sm); // "Flicker"
    const heroName = getHeroName(hero);     // "Silvanna"

    const phrase = `${heroName} ${spellName}`; // "Silvanna Flicker"
    speakAlert(phrase);
  }
}

function speakAlert(text) {
  if (!("speechSynthesis" in window)) return;
  try {
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 1.25;
    utt.pitch = 1.0;
    window.speechSynthesis.speak(utt);
  } catch (e) {}
}
```

---

## 3. Important Implementation Nuances

1. **Audio Context Keepalive:**  
   In PiP mode, Chrome and Safari aggressively throttle background audio unless primed by a prior user gesture. Since `startBackgroundKeepalive()` already starts an inaudible oscillator upon clicking PiP, `speechSynthesis` can fire freely without getting killed by background sleep.
2. **De-duplication:**  
   Keep a cooldown timestamp map per GUID so rapid state re-reads or match-start initialization do not announce false positives.
3. **Hero Name Resolution:**  
   Use `h.hn || HEROES[h.id] || h.n` to ensure human-friendly names (e.g. "Silvanna") rather than raw IDs.
