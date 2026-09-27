/**
 * Draft / Champion select view overlay: displays ally & enemy picks, roles, robot tags, and copyable player IDs.
 */
import { HEROES, ROAD } from "./constants.js";
import { state } from "./state.js";

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));

const heroIconUrl = id => `mlbbicons/${id + 1}.png`;

function createDraftRow(player) {
  const heroName = HEROES[player.heroid] || (player.heroid ? `id${player.heroid}` : "no pick");
  const isSelf = player.camp === 1 && !player.robot;
  const tags = [];

  if (player.robot) tags.push('<span class="dv-tag bot">BOT</span>');
  if (player.rank) tags.push(`<span class="dv-tag">R${esc(player.rank)}</span>`);
  if (player.road) tags.push(`<span class="dv-tag">${esc(ROAD[player.road] || `R${player.road}`)}</span>`);
  if (player.country) tags.push(`<span class="dv-tag">#${esc(player.country)}</span>`);

  const iconHtml = player.heroid
    ? `<img class="dv-ico" src="${heroIconUrl(player.heroid)}" onerror="this.style.visibility='hidden'">`
    : '<div class="dv-ico"></div>';

  const wants = Array.isArray(player.want) ? player.want.filter(Boolean) : [];
  const wantLine = wants.length
    ? `<div class="dv-want">wants: ${wants.map(id => esc(HEROES[id] || `id${id}`)).join(", ")}</div>`
    : "";

  return `
    <div class="dv-row${isSelf ? " self" : ""}">
      ${iconHtml}
      <div class="dv-main">
        <div class="dv-name">${esc(player.name || "???")}</div>
        <div class="dv-hero">${esc(heroName)}</div>
        ${wantLine}
        <div class="dv-uid" data-uid="${esc(player.uid)}" title="Click to copy ID">ID ${esc(player.uid)}</div>
      </div>
      <div class="dv-tags">${tags.join("")}</div>
    </div>
  `;
}

export function initDraftClipboard(containerEl) {
  containerEl.addEventListener("click", ev => {
    const uidEl = ev.target.closest(".dv-uid");
    if (!uidEl) return;

    const id = uidEl.dataset.uid || "";
    if (navigator.clipboard) {
      navigator.clipboard.writeText(id).catch(() => {});
    }

    const prevText = uidEl.textContent;
    uidEl.textContent = `copied ${id}`;
    uidEl.classList.add("copied");

    setTimeout(() => {
      uidEl.textContent = prevText;
      uidEl.classList.remove("copied");
    }, 900);
  });
}

export function updateDraftView(data, elements) {
  const { draftView, dvAlly, dvEnemy, dvMeta } = elements;
  const isDrafting = !data.bm && Array.isArray(data.draft) && data.draft.length > 0;

  if (!isDrafting) {
    if (!draftView.classList.contains("hidden")) {
      draftView.classList.add("hidden");
    }
    state.draftSig = "";
    return;
  }

  const currentSig = JSON.stringify(data.draft);
  if (currentSig !== state.draftSig) {
    state.draftSig = currentSig;

    const byPos = (a, b) => (a.pos || 0) - (b.pos || 0);
    const ally = data.draft.filter(p => p.camp === 1).sort(byPos);
    const enemy = data.draft.filter(p => p.camp === 2).sort(byPos);

    dvAlly.innerHTML = ally.length
      ? ally.map(createDraftRow).join("")
      : '<div class="none">no allies</div>';

    dvEnemy.innerHTML = enemy.length
      ? enemy.map(createDraftRow).join("")
      : '<div class="none">no enemies yet</div>';
  }

  dvMeta.textContent = `players ${data.draft.length} | ${new Date().toLocaleTimeString()}`;
  draftView.classList.remove("hidden");
}
