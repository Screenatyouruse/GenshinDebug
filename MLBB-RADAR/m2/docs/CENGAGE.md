# CENGAGE / WebAssign Automation & Parsing Guide

This guide documents the reverse-engineered DOM architecture, MathML input handling, LLM-friendly question dumper, and batch injection scripts for Cengage WebAssign assignments.

---

## 1. DOM Architecture & Input Mechanism

WebAssign uses server-rendered HTML forms backed by **WIRIS MathType** (`com.wiris.js.JsEditor`) and **MathJax (v2.7.9)**.

### Input Types

1. **Formula / Math Inputs (`RQ_...` or `RA_...`)**:
   - Each interactive math field is backed by a hidden `<input>` in the form:
     ```html
     <input type="hidden" name="RQ_1655834_0_0_1657337" id="RQ_1655834_0_0_1657337" value="...">
     ```
   - Visual styling and keyboard overlay are managed by an adjacent wrapper:
     ```html
     <div id="editable-math-RQ_1655834_0_0_1657337" class="mathtype mtClosed" data-boxid="RQ_1655834_0_0_1657337">
       <span class="mtAnswer">...</span>
     </div>
     ```
   - The value submitted to the backend is **raw W3C MathML XML**.

2. **Multiple Choice / Domain Radios (`RC_...`)**:
   - Standard HTML radio inputs grouped by name:
     ```html
     <input type="radio" id="RC_1655834_0_4_1657337_3" name="RC_1655834_0_4_1657337" value="3">
     ```
   - Values are typically 0-indexed integers representing the choice index.

3. **Submission Buttons (`submit_{qId}_{partIdx}`)**:
   - Each question block has its own dedicated submit button:
     ```html
     <input type="submit" id="submit_1655834_0" name="submit" value="Submit Answer">
     ```
   - Clicking submits only that specific question part via standard `POST`.

---

## 2. LLM-Friendly Question Dumper

Run this snippet in the browser DevTools Console to scrape all questions into a clean markdown format (strips boilerplate, adds input placeholder tags, and copies to your clipboard):

```javascript
(() => {
  const questions = Array.from(document.querySelectorAll('.waQBox')).map((box, idx) => {
    const content = box.querySelector('.studentQuestionContent') || box.querySelector('.qContent');
    if (!content) return null;

    const clone = content.cloneNode(true);

    // 1. Strip UI buttons, accessibility screen-reader junk, and scripts
    clone.querySelectorAll('button, .mathtype-overlay-trigger, .mathtype-sr-only, script, style, .sr-only').forEach(e => e.remove());

    // 2. Replace MathType containers with clean slot identifiers
    clone.querySelectorAll('.mathtype-wrapper').forEach(w => {
      const mt = w.querySelector('.mathtype');
      const boxId = mt ? (mt.dataset.boxid || mt.id.replace('editable-math-', '')) : null;
      if (boxId && !boxId.endsWith('_settings')) {
        w.replaceWith(document.createTextNode(`\n[INPUT_MATH: ${boxId}]\n`));
      } else {
        w.remove();
      }
    });

    // 3. Format radio choices cleanly
    clone.querySelectorAll('input[type="radio"]').forEach(r => {
      r.replaceWith(document.createTextNode(`\n   [CHOICE: name="${r.name}" value="${r.value}"] `));
    });

    // 4. Clean whitespace & newlines
    const promptText = clone.innerText
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .replace(/ResourceseBook/g, '')
      .trim();

    const submitBtn = box.querySelector('input[type="submit"][id^="submit_"]');

    return `### QUESTION ${idx + 1} (Submit: ${submitBtn ? submitBtn.id : 'N/A'})\n\n${promptText}\n`;
  }).filter(Boolean);

  const fullDump = questions.join('\n---\n\n');

  // Copy straight to clipboard and print
  if (typeof copy === 'function') copy(fullDump);
  console.log(fullDump);
  alert(`Dumped ${questions.length} questions! (Copied to your clipboard)`);
})();
```

### Output Format Sample

```markdown
### QUESTION 1 (Submit: submit_1655834_0)

Consider the following functions.
f(x) = x2 + x,    g(x) = x2 − 3 

(a) Find (f + g)(x), (f − g)(x), (fg)(x), and (f/g)(x).

(f + g)(x) = 
[INPUT_MATH: RQ_1655834_0_0_1657337]

(f − g)(x) = 
[INPUT_MATH: RQ_1655834_0_1_1657337]

(b) Find the domain of f + g. 
   [CHOICE: name="RC_1655834_0_4_1657337" value="0"] (3, ∞) 
   [CHOICE: name="RC_1655834_0_4_1657337" value="1"] (−∞, 3) 
   [CHOICE: name="RC_1655834_0_4_1657337" value="3"] (−∞, ∞)
```

---

## 3. Answer Injection & Batch Filler

To apply answers back into the page and trigger MathJax re-rendering:

```javascript
// Provide answers mapped by slot ID
const answers = {
  // Math inputs accept MathML or inner MathML tags
  "RQ_1655834_0_0_1657337": "<mn>2</mn><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mi>x</mi><mo>-</mo><mn>3</mn>",
  "RQ_1655834_0_1_1657337": "<mi>x</mi><mo>+</mo><mn>3</mn>",
  "RQ_1655834_0_2_1657337": "<msup><mi>x</mi><mn>4</mn></msup><mo>+</mo><msup><mi>x</mi><mn>3</mn></msup><mo>-</mo><mn>3</mn><msup><mi>x</mi><mn>2</mn></msup><mo>-</mo><mn>3</mn><mi>x</mi>",
  "RQ_1655834_0_3_1657337": "<mfrac><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mi>x</mi></mrow><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>-</mo><mn>3</mn></mrow></mfrac>",

  // Radio choices accept the choice value string
  "RC_1655834_0_4_1657337": "3",
  "RC_1655834_0_5_1657337": "4",
  "RC_1655834_0_6_1657337": "0",
  "RC_1655834_0_7_1657337": "4"
};

// Batch injector function
function applyAnswers(dict) {
  Object.entries(dict).forEach(([key, val]) => {
    if (key.startsWith('RC_')) {
      // Radio choice
      const radio = document.querySelector(`input[type="radio"][name="${key}"][value="${val}"]`);
      if (radio) {
        radio.checked = true;
      }
    } else {
      // Math input
      const input = document.getElementById(key);
      if (input) {
        const mathML = val.startsWith('<math')
          ? val
          : `<math xmlns="http://www.w3.org/1998/Math/MathML">${val}</math>`;
        input.value = mathML;
        
        // Re-render visual preview via MathJax
        if (window.mathTypeOverlay && typeof window.mathTypeOverlay.renderPreview === 'function') {
          window.mathTypeOverlay.renderPreview(key);
        }
      }
    }
  });
}

// Run injection
applyAnswers(answers);
```

---

## 4. Submitting Questions Programmatically

To trigger submission of a specific question:

```javascript
// Submit question by its submit button ID (e.g. Question 1)
document.getElementById('submit_1655834_0')?.click();
```

---

## 5. Complete `WAKit` Framework Script

This is the all-in-one standalone framework object. You can paste it into DevTools Console or wrap it in a Tampermonkey script. It exposes methods to parse, dump (markdown & JSON), set math answers, set radio answers, batch apply answers, and submit questions:

```javascript
(() => {
  window.WAKit = {
    /**
     * 1. PARSE: Extracts all questions, math boxes (RQ_/RA_), and radio choices (RC_)
     */
    parseAllQuestions() {
      const submitButtons = Array.from(document.querySelectorAll('input[type="submit"][id^="submit_"]'));
      
      const questions = submitButtons.map((btn, index) => {
        const match = btn.id.match(/^submit_([0-9]+)_([0-9]+)$/);
        if (!match) return null;
        const [_, qId, partIdx] = match;
        const prefix = `${qId}_${partIdx}`;

        // Extract MathType formula input fields (RQ_... or RA_...)
        const mathInputs = Array.from(document.querySelectorAll(`input[type="hidden"][id^="RQ_${prefix}_"], input[type="hidden"][id^="RA_${prefix}_"]`))
          .filter(i => !i.id.endsWith('_settings'))
          .map(i => {
            const wrapper = i.closest('.mathtype-wrapper');
            const labelEl = wrapper ? wrapper.previousElementSibling : null;
            return {
              boxId: i.id,
              label: labelEl ? labelEl.innerText.trim().replace(/\s+/g, ' ') : 'Formula Input',
              currentValue: i.value
            };
          });

        // Extract Multiple Choice / Radios (RC_...)
        const radioInputs = Array.from(document.querySelectorAll(`input[type="radio"][name^="RC_${prefix}_"]`));
        const radioGroupsMap = {};
        radioInputs.forEach(r => {
          if (!radioGroupsMap[r.name]) {
            radioGroupsMap[r.name] = { name: r.name, choices: [] };
          }
          radioGroupsMap[r.name].choices.push({
            id: r.id,
            value: r.value,
            checked: r.checked,
            label: r.parentElement ? r.parentElement.innerText.trim().replace(/\s+/g, ' ') : ''
          });
        });

        return {
          questionNumber: index + 1,
          qId,
          partIdx,
          submitButtonId: btn.id,
          mathInputs,
          radioGroups: Object.values(radioGroupsMap)
        };
      }).filter(Boolean);

      return questions;
    },

    /**
     * 2. DUMP: Scrapes questions into a clean, LLM-friendly Markdown format
     * Copies straight to clipboard if copy() is available.
     */
    dump(copyToClipboard = true) {
      const questions = Array.from(document.querySelectorAll('.waQBox')).map((box, idx) => {
        const content = box.querySelector('.studentQuestionContent') || box.querySelector('.qContent');
        if (!content) return null;

        const clone = content.cloneNode(true);

        // Strip UI clutter
        clone.querySelectorAll('button, .mathtype-overlay-trigger, .mathtype-sr-only, script, style, .sr-only').forEach(e => e.remove());

        // Replace MathType inputs with clean slot placeholder
        clone.querySelectorAll('.mathtype-wrapper').forEach(w => {
          const mt = w.querySelector('.mathtype');
          const boxId = mt ? (mt.dataset.boxid || mt.id.replace('editable-math-', '')) : null;
          if (boxId && !boxId.endsWith('_settings')) {
            w.replaceWith(document.createTextNode(`\n[INPUT_MATH: ${boxId}]\n`));
          } else {
            w.remove();
          }
        });

        // Replace radio buttons with choice indicator
        clone.querySelectorAll('input[type="radio"]').forEach(r => {
          r.replaceWith(document.createTextNode(`\n   [CHOICE: name="${r.name}" value="${r.value}"] `));
        });

        const promptText = clone.innerText
          .replace(/[ \t]+/g, ' ')
          .replace(/\n\s*\n+/g, '\n\n')
          .replace(/ResourceseBook/g, '')
          .trim();

        const submitBtn = box.querySelector('input[type="submit"][id^="submit_"]');

        return `### QUESTION ${idx + 1} (Submit: ${submitBtn ? submitBtn.id : 'N/A'})\n\n${promptText}\n`;
      }).filter(Boolean);

      const fullDump = questions.join('\n---\n\n');

      if (copyToClipboard && typeof copy === 'function') {
        copy(fullDump);
        console.log(`[WAKit] Dumped ${questions.length} questions and copied to clipboard!`);
      } else {
        console.log(`[WAKit] Dumped ${questions.length} questions.`);
      }

      return fullDump;
    },

    /**
     * 3. INPUT MATH: Sets MathML into the hidden input and renders native MathJax preview
     */
    setMathAnswer(boxId, mathML) {
      const input = document.getElementById(boxId);
      if (!input) {
        console.error(`[WAKit] Input field '${boxId}' not found.`);
        return false;
      }

      if (!mathML.startsWith('<math')) {
        mathML = `<math xmlns="http://www.w3.org/1998/Math/MathML">${mathML}</math>`;
      }

      input.value = mathML;

      if (window.mathTypeOverlay && typeof window.mathTypeOverlay.renderPreview === 'function') {
        window.mathTypeOverlay.renderPreview(boxId);
      }

      console.log(`[WAKit] Set math for ${boxId}:`, mathML);
      return true;
    },

    /**
     * 4. INPUT RADIO: Selects a choice by radio element ID or group name + value
     */
    setRadioAnswer(radioIdOrName, value) {
      if (value !== undefined) {
        const radio = document.querySelector(`input[type="radio"][name="${radioIdOrName}"][value="${value}"]`);
        if (radio) {
          radio.checked = true;
          return true;
        }
      } else {
        const radio = document.getElementById(radioIdOrName);
        if (radio) {
          radio.checked = true;
          return true;
        }
      }
      console.error(`[WAKit] Radio button not found:`, radioIdOrName);
      return false;
    },

    /**
     * 5. BATCH APPLY: Takes an object of { [slotId]: value } and applies all
     */
    applyBatch(answers) {
      let applied = 0;
      Object.entries(answers).forEach(([key, val]) => {
        if (key.startsWith('RC_')) {
          if (this.setRadioAnswer(key, val)) applied++;
        } else {
          if (this.setMathAnswer(key, val)) applied++;
        }
      });
      console.log(`[WAKit] Applied ${applied} answers.`);
      return applied;
    },

    /**
     * 6. SUBMIT: Clicks the submit button for a specific question (1-indexed)
     */
    submitQuestion(questionNumber) {
      const questions = this.parseAllQuestions();
      const target = questions.find(q => q.questionNumber === questionNumber);
      if (target) {
        const btn = document.getElementById(target.submitButtonId);
        if (btn) {
          console.log(`[WAKit] Submitting Question ${questionNumber} (${btn.id})...`);
          btn.click();
          return true;
        }
      }
      console.error(`[WAKit] Question ${questionNumber} not found.`);
      return false;
    }
  };

  console.log('[WAKit] Loaded! Call WAKit.dump() to copy all questions.');
})();
```

---

## 6. Quick MathML Syntax Reference

| Expression | MathML Fragment |
|---|---|
| Powers ($x^2$) | `<msup><mi>x</mi><mn>2</mn></msup>` |
| Subscripts ($x_1$) | `<msub><mi>x</mi><mn>1</mn></msub>` |
| Fractions ($\frac{A}{B}$) | `<mfrac><mrow>A</mrow><mrow>B</mrow></mfrac>` |
| Square Root ($\sqrt{x}$) | `<msqrt><mi>x</mi></msqrt>` |
| $n$-th Root ($\sqrt[n]{x}$) | `<mroot><mrow>x</mrow><mn>n</mn></mroot>` |
| Operators ($+$, $-$, $\cdot$) | `<mo>+</mo>`, `<mo>-</mo>`, `<mo>·</mo>` |
| Numbers | `<mn>123</mn>` |
| Variables | `<mi>x</mi>` |




UPDATE:

---

### 1. The Question Dumper Skips Scalar Inputs (`RN_...` / Standard Text)

In Question 6, parts (c) and (d) (`f(g(-3))` and `g(f(4))`) did not appear as `INPUT_MATH` placeholders in the initial dump.

* **Why**: The original regex/selectors strictly looked for `.mathtype-wrapper`. WebAssign frequently renders scalar or numeric follow-up inputs as plain `<input type="text">` with names like `RN_...` or un-wrapped standard inputs.


* **Fix for `CENGAGE.md**`: Update the dumper script to detect and replace standard `<input type="text">` fields with `[INPUT_TEXT: name]` markers so scalar answers aren't invisibly omitted.

---

### 2. Comma-Separated Set / List MathML Formatting

Question 10 required multiple roots as a comma-separated list (`x = 1, 7/2`).

* **MathML Syntax Note**: MathType parses the comma as an operator `<mo>,</mo>`.

```html
<!-- Single input containing multiple values -->
<mn>1</mn><mo>,</mo><mfrac><mn>7</mn><mn>2</mn></mfrac>

```

* Adding an explicit entry in Section 6 ("Quick MathML Syntax Reference") prevents formatting errors when handling multi-root solution sets.



---

### 3. Outer-Function Radical Confusion in Scraped Text

In Question 7, the prompt text scraped from DevTools was:

> `f(x) = x2 − 9,    g(x) = 7x`

* In the rendered DOM, this was actually $f(x) = x^2 - 9$ and $g(x) = \sqrt{7x}$.


* Because the HTML parser stripped or flattened radical symbols into plain text, $g(x)$ looked like `7x`, and the first composition attempt accidentally wrapped $f$ in a non-existent square root.
* **Doc Addition**: Add a note under Section 2 ("Dumper Gotchas") warning that root symbols (`√`) or MathType radicals inside problem statements can collapse into raw text if the scraper only reads `.innerText`. Re-check the source MathML/image whenever functions have fractional powers or square roots.



---

### 4. Direct Composed Domain Rule (Outer Exclusion vs. Inner Range)

For composition domains like $f(g(x))$ in Questions 8 and 9:

* WebAssign tests two distinct checks simultaneously:
1. $x$ must be in the domain of $g(x)$.
2. $g(x)$ must be in the domain of $f(x)$ (i.e., solve $g(x) = \text{excluded value of } f$).


* In Question 9, with $f(x) = \frac{x-1}{x-2}$ and $g(x) = \frac{x-7}{x-8}$:


* Step 1 excludes $x = 8$.
* Step 2 sets $\frac{x-7}{x-8} = 2 \implies x = 9$.
* Excluded set is $\mathbb{R} \setminus \{8, 9\}$.




* Adding this standard two-step verification checklist into a small "Composition Domain Traps" reference block eliminates confusion between domain choices like $\mathbb{R} \setminus \{8, 9\}$ versus $\mathbb{R} \setminus \{2, 15/7\}$.