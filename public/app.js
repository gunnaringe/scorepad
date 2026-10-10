// Poengblokka / Scorepad UI. Plain DOM, hash routing, no framework.
//
// Routes:  #/                 home
//          #/s/:sid           session (a game night: its games)
//          #/s/:sid/new       new game (?from=:gid prefills, "play again")
//          #/s/:sid/g/:gid    game table
//          #/s/:sid/g/:gid/edit  change name and rules
//          #/s/:sid/dash      big screen, follows the active game
//          #/s/:sid/g/:gid/dash  big screen pinned to one game
// Shared links are /s/CODE (served index.html by the SPA fallback) and are
// turned into a local session record, then a hash route.

import {
  DEFAULT_RULES, PRESET_IDS, presetRules, rulesOf, matchPreset, sanitizeRules, playerProblem,
  summarize, cardsFor, tricksTotal, teamTricks, minBid, scoreRound, bidBalance, dealerFor,
} from './rules.js';
import { newId, reduce } from './core.js';
import * as store from './store.js';
import { I18N } from './i18n.js';
import qrcodegen from './qrcodegen.js';

let settings = store.loadSettings();
let live = null;
let route = { name: 'home' };
let draft = null; // new-game form
let form = null; // round sheet
let prevTotals = {}; // big screen bump animation

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const dlg = $('#dlg');
const sheet = $('#sheet');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// --- i18n ----------------------------------------------------------------------

function lang() {
  if (settings.lang === 'no' || settings.lang === 'en') return settings.lang;
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => /^(nb|nn|no)\b/i.test(l)) ? 'no' : 'en';
}
const locale = () => (lang() === 'no' ? 'nb-NO' : 'en-GB');

function t(key, vars = {}) {
  const s = I18N[lang()][key] ?? I18N.no[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
// Escaped, for building HTML. Vars may be user text.
const tt = (key, vars) => esc(t(key, vars));

function applyI18n(root = document) {
  for (const el of $$('[data-i18n]', root)) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-title]', root)) el.title = el.ariaLabel = t(el.dataset.i18nTitle);
  for (const el of $$('[data-i18n-placeholder]', root)) el.placeholder = t(el.dataset.i18nPlaceholder);
}

const fmt = (n) => (n < 0 ? `−${-n}` : String(n));
const signed = (n) => (n > 0 ? `+${n}` : n === 0 ? '±0' : fmt(n));

function dateLabel(ms) {
  const s = new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ms));
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const timeLabel = (ms) => new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

// --- Helpers -------------------------------------------------------------------

const state = () => live?.state;
const pname = (pid) => state()?.players[pid]?.name ?? '?';
const names = (pids) => pids.map(pname).join(', ');
const gameName = (g) => g.name || t('game.untitled');
const entryOf = (g) => rulesOf(g).entry;
const pressed = (on) => `aria-pressed="${on ? 'true' : 'false'}"`;

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) $('button', el).onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 8000 : 3500);
}

function qrSvg(text) {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const b = 2;
  const size = qr.size + b * 2;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) d += `M${x + b},${y + b}h1v1h-1z`;
  }
  return `<svg class="qr" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#1b1410"/></svg>`;
}

const shareUrl = (code) => `${location.origin}/s/${code}`;

// The share code in a bar. Lives in a .chip-slot, so sharing later fills it.
function statusChip() {
  if (!live?.shared) return '';
  return `<button type="button" class="status-chip status-${live.status}" data-act="share" title="${tt(`status.${live.status}`)}"><span class="dot"></span>${esc(live.rec.code)}</button>`;
}
const chipSlot = () => `<span class="chip-slot">${statusChip()}</span>`;

// --- Theme, wake lock --------------------------------------------------------------

function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.lang = lang() === 'no' ? 'nb' : 'en';
  document.title = t('app.name');
  $('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bar').trim() || '#3b2417';
  applyI18n();
}

let wakeLock = null;
async function updateWake() {
  const want = (settings.wake || route.name === 'dash') && document.visibilityState === 'visible';
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
      // Not allowed (battery saver, iframe): fine.
    }
  } else if (!want && wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', updateWake);

// --- Routing -------------------------------------------------------------------

function parseRoute() {
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const q = new URLSearchParams(query ?? '');
  if (parts[0] !== 's' || !parts[1]) return { name: 'home' };
  const r = { sid: parts[1], name: 'session' };
  if (parts[2] === 'new') Object.assign(r, { name: 'new', from: q.get('from') });
  else if (parts[2] === 'dash') r.name = 'dash';
  else if (parts[2] === 'g' && parts[3] && parts[4] === 'edit') Object.assign(r, { name: 'new', edit: parts[3] });
  else if (parts[2] === 'g' && parts[3]) Object.assign(r, { gid: parts[3], name: parts[4] === 'dash' ? 'dash' : 'game' });
  return r;
}

function ensureLive(sid) {
  if (live?.rec.id === sid) return true;
  live?.close();
  live = null;
  const rec = store.loadSession(sid);
  if (!rec) return false;
  live = new store.Live(rec, onLive);
  return true;
}

function onLive(what) {
  if (what === 'state' || what === 'status') {
    if (route.name === 'game') updateGame();
    else if (route.name === 'dash') renderDash();
    else if (route.name === 'session') renderSession();
  }
  if (what === 'state' && form && sheet.open) checkStale();
  for (const el of $$('.chip-slot')) el.innerHTML = statusChip();
  if (dlg.open && dlg.dataset.kind === 'settings') refreshConnection();
  if (dlg.open && dlg.dataset.kind === 'share' && what !== 'devices') renderShare();
}

function render() {
  const prev = route;
  route = parseRoute();
  if (route.sid && !ensureLive(route.sid)) return go('#/');
  if (!route.sid) {
    live?.close();
    live = null;
  }
  if (route.name !== 'new') draft = null;
  view.onclick = view.onchange = null;
  if (sheet.open && (prev.gid !== route.gid || route.name !== 'game')) closeSheet();
  document.body.dataset.view = route.name;
  if ((route.name === 'game' && !state().games[route.gid]) || (route.edit && !state().games[route.edit])) return go(`#/s/${route.sid}`);
  ({ home: renderHome, session: renderSession, new: renderNew, game: renderGame, dash: renderDash })[route.name]();
  if (prev.name !== route.name || prev.gid !== route.gid) window.scrollTo(0, 0);
  updateWake();
}

addEventListener('hashchange', render);

// Clicks on [data-act] anywhere in the view.
const actions = {
  settings: () => openSettings(),
  share: () => openShare(),
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act] && !el.closest('dialog')) {
    e.preventDefault();
    actions[el.dataset.act](el);
  }
});

// --- Home ----------------------------------------------------------------------

const reduceRec = (rec) => (live?.rec.id === rec.id ? live.state : reduce([...rec.events, ...rec.pending]));

// The game to jump back into: the most recently touched unfinished one.
function resumeGame(s) {
  return s.gameOrder.map((id) => s.games[id])
    .filter((g) => !summarize(g).done)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
}

// Tonight's session, which "Nytt spill" continues: shared, or from today.
function tonight(rec) {
  return rec && ((rec.code && !rec.expired) || sameDay(rec.updatedAt, Date.now()));
}

function progressLabel(sum) {
  if (sum.done) return tt('game.finished', { n: sum.completed });
  return sum.totalRounds ? tt('game.roundOf', { n: sum.current + 1, of: sum.totalRounds }) : tt('game.round', { n: sum.current + 1 });
}

function renderHome() {
  // "New game" makes a record up front; drop the ones abandoned before a game
  // was started (never shared, nothing in them).
  for (const rec of store.listSessions()) {
    if (!rec.code && !rec.events.length && !rec.pending.length) store.deleteSession(rec.id);
  }
  const sessions = store.listSessions();
  const [latest, ...older] = sessions;
  const item = (rec, cls = '') => {
    const s = reduceRec(rec);
    const players = s.playerOrder.slice(0, 6).map((pid) => s.players[pid].name);
    const g = resumeGame(s);
    const href = g ? `#/s/${rec.id}/g/${g.id}` : `#/s/${rec.id}`;
    return `<a class="card session-card ${cls}" href="${href}">
      <span class="session-date">${esc(dateLabel(rec.createdAt))}${rec.code && !rec.expired ? ` <span class="badge">${tt('session.shared')}</span>` : ''}</span>
      ${g ? `<span class="session-game">${esc(gameName(g))} · ${progressLabel(summarize(g))}</span>` : ''}
      <span class="session-meta">${tt(s.gameOrder.length === 1 ? 'session.game' : 'session.games', { n: s.gameOrder.length })}${players.length ? ` · ${esc(players.join(', '))}` : ''}</span>
    </a>`;
  };
  const cont = tonight(latest);
  view.innerHTML = `
    <header class="hero">
      <div class="hero-top"><span></span><button type="button" class="icon-btn" data-act="settings" data-i18n-title="settings.title">${icon('gear')}</button></div>
      <div class="hero-art" aria-hidden="true"></div>
      <h1>${tt('app.name')}</h1>
      <p>${tt('app.tagline')}</p>
    </header>
    <main class="page">
      <div class="stack">
        <div class="stack tight">
          <button type="button" class="btn primary big" id="new-game">${icon('plus')}${tt('home.new')}</button>
          ${cont ? `<button type="button" class="link" id="new-night">${tt('home.newNight')}</button>` : ''}
        </div>
        ${latest ? `<section><h2>${tt('home.continue')}</h2>${item(latest, 'latest')}</section>` : ''}
        <section class="card join">
          <h2><label for="join-code">${tt('home.join')}</label></h2>
          <form id="join-form" class="row">
            <input id="join-code" class="code-input" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="K7QX4M" aria-describedby="join-error">
            <button class="btn">${tt('home.joinBtn')}</button>
          </form>
          <p class="field-error" id="join-error" role="alert" hidden></p>
          <p class="hint">${tt('home.joinHint')}</p>
        </section>
        ${older.length ? `<section><h2>${tt('home.earlier')}</h2><div class="stack tight">${older.slice(0, 30).map((r) => item(r)).join('')}</div></section>` : ''}
      </div>
    </main>`;
  applyI18n(view);
  $('#new-game').onclick = () => go(`#/s/${(cont ? latest : store.newSession()).id}/new`);
  $('#new-night')?.addEventListener('click', () => go(`#/s/${store.newSession().id}/new`));
  $('#join-form').onsubmit = (e) => {
    e.preventDefault();
    join($('#join-code').value);
  };
  $('#join-code').oninput = () => { $('#join-error').hidden = true; };
}

// True if it navigated to the session. Errors go under the code field when
// it's on screen, else in a toast.
async function join(raw, dash = false) {
  const fail = (key) => {
    const el = $('#join-error');
    if (el) {
      el.textContent = t(key);
      el.hidden = false;
    } else toast(t(key));
    return false;
  };
  const code = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return fail('join.bad');
  const target = (rec) => `#/s/${rec.id}${dash ? '/dash' : ''}`;
  const existing = store.findByCode(code);
  if (existing) return go(target(existing)), true;
  let ok;
  try {
    ok = await store.sessionExists(code);
  } catch {
    return fail('join.offline');
  }
  if (!ok) return fail('join.missing');
  go(target(store.newSession({ code })));
  return true;
}

// --- Session -------------------------------------------------------------------

function renderSession() {
  const s = state();
  const games = [...s.gameOrder].reverse().map((id) => s.games[id]);
  const card = (g) => {
    const sum = summarize(g);
    const lead = sum.leaders.length && sum.completed
      ? sum.done
        ? `🏆 ${tt('game.won', { names: names(sum.winners) })}`
        : tt('game.leads', { names: names(sum.leaders), score: fmt(sum.totals[sum.leaders[0]]) })
      : tt('game.notStarted');
    return `<a class="card game-card${sum.done ? ' done' : ''}" href="#/s/${route.sid}/g/${g.id}">
      <span class="game-card-top"><strong>${esc(gameName(g))}</strong><span class="muted">${progressLabel(sum)}</span></span>
      <span class="game-card-players">${esc(names(g.players))}</span>
      <span class="game-card-lead">${lead}</span>
    </a>`;
  };
  view.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" data-i18n-title="nav.home">${icon('back')}</a>
      <h1>${esc(dateLabel(live.rec.createdAt))}</h1>
      ${chipSlot()}
      <button type="button" class="icon-btn" data-act="settings" data-i18n-title="settings.title">${icon('gear')}</button>
    </header>
    <main class="page">
      <div class="stack">
        ${live.rec.expired ? `<p class="notice">${tt('session.expired')}</p>` : ''}
        <div class="tiles">
          <a class="btn primary tile" href="#/s/${route.sid}/new">${icon('plus')}<span>${tt('session.newGame')}</span></a>
          <button type="button" class="btn tile" data-act="share">${icon('qr')}<span>${tt('session.share')}</span></button>
          <a class="btn tile" href="#/s/${route.sid}/dash">${icon('tv')}<span>${tt('session.dashboard')}</span></a>
        </div>
        ${games.length ? `<div class="stack tight">${games.map(card).join('')}</div>` : `<p class="empty">${tt('session.empty')}</p>`}
        <button type="button" class="link danger" id="delete-session">${tt('session.delete')}</button>
      </div>
    </main>`;
  applyI18n(view);
  $('#delete-session').onclick = () => {
    if (!confirm(t('session.deleteConfirm'))) return;
    const id = live.rec.id;
    live.close();
    live = null;
    store.deleteSession(id);
    go('#/');
  };
}

// --- New game / edit game ------------------------------------------------------------
//
// A game is a name plus rules. The presets only fill in the rules; every rule
// can be changed, also later from the game menu (old rounds are rescored).

// What an unnamed game is called: its preset, or "Own rules".
const suggestedName = (rules) => {
  const p = matchPreset(rules);
  return p ? t(`preset.${p}`) : t('rules.ownName');
};

// Names the app made up (in either language) aren't carried over: an empty
// name follows the rules when another preset is picked.
const autoName = (name) => !name || ['no', 'en'].some((l) =>
  [...PRESET_IDS.map((id) => I18N[l][`preset.${id}`]), I18N[l]['rules.ownName']].includes(name));

function initDraft() {
  const s = state();
  if (route.edit) {
    const g = s.games[route.edit];
    // When editing, the dealer marker is who deals now (the current round).
    draft = {
      edit: g.id,
      name: autoName(g.name) ? '' : g.name,
      rules: rulesOf(g),
      players: g.players.map((pid) => ({ pid, name: pname(pid) })),
      firstDealer: Math.max(0, g.players.indexOf(summarize(g).dealer)),
    };
    return;
  }
  const from = s.games[route.from] ?? s.games[s.gameOrder.at(-1)];
  if (from) {
    draft = {
      // "Play again" keeps a name you chose; a new game starts unnamed.
      name: route.from && !autoName(from.name) ? from.name : '',
      rules: rulesOf(from),
      players: from.players.map((pid) => ({ pid, name: pname(pid) })),
      firstDealer: route.from ? (from.firstDealer + 1) % from.players.length : 0,
    };
  } else {
    draft = { name: '', rules: presetRules('selbuvist'), players: [], firstDealer: 0 };
  }
}

function hitText(r) {
  return [r.hitBase || '', r.hitPerTrick ? `${r.hitPerTrick === 1 ? '' : `${r.hitPerTrick} × `}${t('sum.bid')}` : ''].filter(Boolean).join(' + ') || '0';
}

// The rules in plain words, one line per rule that matters.
function rulesSummary(r) {
  const lines = [t(`sum.entry.${r.entry}`)];
  if (r.entry !== 'scores') {
    const rounds = r.cards === 'updown' || r.cards === 'downup' ? r.maxCards * 2 : 0;
    lines.push(t(`sum.cards.${r.cards}`, { max: r.maxCards, n: rounds }));
  }
  if (r.entry === 'bids') {
    lines.push(t('sum.hit', { hit: hitText(r) }));
    lines.push(r.missPerTrick ? t('sum.missPer', { n: r.missPerTrick }) : t('sum.miss0'));
    if (r.trickPoints) lines.push(t('sum.trickPoints', { n: r.trickPoints }));
  }
  if (r.entry === 'contract') {
    lines.push(t('sum.made') + (r.doubleKurtier ? ` ${t('sum.double')}` : '') + (r.halfPartner ? ` ${t('sum.half')}` : ''));
    lines.push(t(r.fail === 'zero' ? 'sum.fail0' : 'sum.failMinus'));
    lines.push(t('sum.others', { n: r.othersPerTrick }));
    if (r.minHalf) lines.push(t('sum.minHalf'));
    if (r.allTricksWins && r.target > 0) lines.push(t('sum.allTricks', { n: r.target }));
  }
  if (r.target > 0) lines.push(t('sum.target', { n: r.target }));
  lines.push(t(r.lowWins ? 'sum.low' : 'sum.high'));
  return lines;
}

// The same, on one line: "Bud og stikk · 1→10→1 kort · treff 10 + bud · bom 0".
function compactSummary(r) {
  const parts = [t(`rule.entry.${r.entry}`)];
  if (r.entry !== 'scores' && r.cards !== 'none') parts.push(t(`cs.cards.${r.cards}`, { max: r.maxCards }));
  if (r.entry === 'bids') {
    parts.push(t('cs.hit', { hit: hitText(r) }));
    parts.push(r.missPerTrick ? t('cs.missPer', { n: r.missPerTrick }) : t('cs.miss0'));
  }
  if (r.entry === 'contract') parts.push(t(r.fail === 'zero' ? 'cs.fail0' : 'cs.failMinus'));
  if (r.target > 0) parts.push(t('cs.target', { n: r.target }));
  if (r.lowWins) parts.push(t('cs.low'));
  return parts.join(' · ');
}

const SOURCES = {
  selbuvist: '<a href="https://no.wikipedia.org/wiki/Selbuvist" target="_blank" rel="noopener">Wikipedia: Selbuvist</a>',
  amerikaner: '<a href="https://no.wikipedia.org/wiki/Amerikaner_(kortspill)" target="_blank" rel="noopener">Wikipedia: Amerikaner</a>',
};

function ruleField(key) {
  const r = draft.rules;
  const def = DEFAULT_RULES[key];
  const label = tt(`rule.${key}`);
  const hint = I18N.no[`rule.${key}.hint`] ? `<small class="muted">${tt(`rule.${key}.hint`)}</small>` : '';
  if (typeof def === 'boolean') {
    return `<label class="switch-row"><span>${label}${hint}</span><input type="checkbox" class="switch" data-rule="${key}"${r[key] ? ' checked' : ''}></label>`;
  }
  if (typeof def === 'number') {
    return `<label class="field-row"><span>${label}${hint}</span><input type="number" inputmode="numeric" class="num" data-rule="${key}" value="${r[key]}"></label>`;
  }
  const opts = { entry: ['scores', 'bids', 'contract'], cards: ['none', 'updown', 'downup', 'fixed', 'deck'], fail: ['minus', 'zero'] }[key];
  return `<div class="field-col" role="group" aria-label="${label}"><span>${label}</span><div class="segmented">${opts.map((o) =>
    `<button type="button" data-rule="${key}" data-val="${o}" class="${r[key] === o ? 'on' : ''}" ${pressed(r[key] === o)}>${tt(`rule.${key}.${o}`)}</button>`).join('')}</div></div>`;
}

function ruleFields() {
  const r = draft.rules;
  const groups = [['entry']];
  if (r.entry !== 'scores') {
    groups.push(['cards', ...(['updown', 'downup', 'fixed'].includes(r.cards) ? ['maxCards'] : [])]);
  }
  if (r.entry === 'bids') groups.push(['hitBase', 'hitPerTrick', 'missPerTrick', 'trickPoints']);
  if (r.entry === 'contract') groups.push(['fail', 'othersPerTrick', 'doubleKurtier', 'halfPartner', 'minHalf', 'allTricksWins']);
  groups.push(['target', 'lowWins']);
  return groups.map((keys) => `<div class="rule-group">${keys.map(ruleField).join('')}</div>`).join('');
}

function renderNew() {
  if (!draft) initDraft();
  const r = draft.rules;
  const editing = !!draft.edit;
  const preset = matchPreset(r);
  const n = draft.players.length;
  const problem = playerProblem(r, n);
  const chips = candidates().slice(0, 14);
  const back = editing ? `#/s/${route.sid}/g/${draft.edit}` : `#/s/${route.sid}`;
  const nameSection = `<section>
    <h2><label for="gname">${tt('new.nameOptional')}</label></h2>
    <input id="gname" class="text-input" maxlength="40" autocomplete="off" value="${esc(draft.name)}" placeholder="${esc(suggestedName(r))}">
  </section>`;
  view.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="${back}" data-i18n-title="nav.back">${icon('back')}</a>
      <h1>${tt(editing ? 'new.editTitle' : 'new.title')}</h1>
      <button type="button" class="icon-btn" data-act="settings" data-i18n-title="settings.title">${icon('gear')}</button>
    </header>
    <main class="page">
      <div class="stack">
        ${editing ? nameSection : ''}
        <section>
          <h2>${tt('new.rules')}</h2>
          <div class="presets" role="radiogroup" aria-label="${tt('new.presets')}">
            ${PRESET_IDS.map((id) => `<button type="button" role="radio" aria-checked="${id === preset}" class="preset${id === preset ? ' on' : ''}" data-preset="${id}">${esc(t(`preset.${id}`))}</button>`).join('')}
            ${preset ? '' : `<span class="preset own on" role="radio" aria-checked="true">${tt('rules.own')}</span>`}
          </div>
          <div class="card rules-card">
            ${preset ? '' : `<p class="rules-compact">${esc(compactSummary(r))}</p>`}
            <details class="rules-editor"${draft.open ? ' open' : ''}>
              <summary>${tt('new.customize')}</summary>
              ${preset ? '' : `<ul class="rules-summary">${rulesSummary(r).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`}
              ${SOURCES[preset] ? `<p class="small muted">${SOURCES[preset]}</p>` : ''}
              ${ruleFields()}
            </details>
          </div>
        </section>

        <section>
          <h2>${tt('new.playersTitle')} <span class="muted">${n}</span></h2>
          <p class="hint seat-hint">${tt(editing ? 'new.editPlayersHint' : 'new.seatHint')}</p>
          ${n ? `<ol class="seats">${draft.players.map((pl, i) => `
            <li>
              <span class="seat-no">${i + 1}</span>
              ${draft.renaming === i
                ? `<input class="seat-input" data-rename-input="${i}" maxlength="40" value="${esc(pl.name)}" aria-label="${tt('new.rename', { name: pl.name })}" enterkeyhint="done" autocapitalize="words">`
                : `<button type="button" class="seat-name" data-rename="${i}" title="${tt('new.rename', { name: pl.name })}">${esc(pl.name)}${icon('edit')}</button>`}
              <button type="button" class="dealer-btn${i === draft.firstDealer ? ' on' : ''}" data-dealer="${i}" ${pressed(i === draft.firstDealer)} title="${tt(editing ? 'new.dealsNow' : 'new.dealsFirst')}">${tt('new.dealer')}</button>
              <button type="button" class="icon-btn small" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} data-i18n-title="new.up">${icon('up')}</button>
              <button type="button" class="icon-btn small" data-move="${i}" data-dir="1" ${i === n - 1 ? 'disabled' : ''} data-i18n-title="new.down">${icon('down')}</button>
              <button type="button" class="icon-btn small" data-remove="${i}" data-i18n-title="new.remove">${icon('x')}</button>
            </li>`).join('')}</ol>` : ''}
          <form class="add-player" id="add-form" autocomplete="off">
            <div class="combo">
              <input id="pname" enterkeyhint="done" maxlength="40" placeholder="${tt('new.addPlaceholder')}" aria-label="${tt('new.addPlaceholder')}" aria-autocomplete="list" aria-controls="suggest" autocapitalize="words">
              <ul id="suggest" class="suggest" role="listbox" hidden></ul>
            </div>
            <button class="btn" aria-label="${tt('new.add')}">${icon('plus')}</button>
          </form>
          ${chips.length ? `<div class="chips">${chips.map((c) => `<button type="button" class="chip" data-add="${esc(c)}">+ ${esc(c)}</button>`).join('')}</div>` : ''}
          ${problem && n ? `<p class="hint warn">${tt(problem.key, problem)}</p>` : ''}
        </section>
        ${editing ? `<p class="hint">${tt('new.editHint')}</p>` : nameSection}
      </div>
    </main>
    <footer class="action-bar">
      <button type="button" class="btn primary big" id="start" ${n && !problem ? '' : 'disabled'}>${tt(editing ? 'new.save' : 'new.start')}</button>
    </footer>`;
  applyI18n(view);
  wireNew();
}

function candidates() {
  const s = state();
  // Names in the draft, and the old names of players being renamed.
  const taken = new Set(draft.players.flatMap((p) => [p.name, s.players[p.pid]?.name ?? p.name]).map((n) => n.toLocaleLowerCase()));
  const seen = new Set();
  const out = [];
  for (const name of [...s.playerOrder.map((pid) => s.players[pid].name), ...store.recentPlayers().map((p) => p.name)]) {
    const key = name.toLocaleLowerCase();
    if (taken.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function addDraftPlayer(raw) {
  const name = raw.trim().slice(0, 40);
  if (!name) return;
  const key = name.toLocaleLowerCase();
  if (draft.players.some((p) => p.name.toLocaleLowerCase() === key)) return;
  const s = state();
  const existing = s.playerOrder.find((pid) => s.players[pid].name.toLocaleLowerCase() === key);
  draft.players.push({ pid: existing ?? null, name: existing ? s.players[existing].name : name });
}

// Re-render without losing the page's scroll position.
function rerenderNew() {
  const y = window.scrollY;
  draft.open = $('.rules-editor')?.open ?? draft.open;
  renderNew();
  window.scrollTo(0, y);
}

function wireNew() {
  const keepFocus = (fn) => () => {
    fn();
    rerenderNew();
    $('#pname')?.focus();
  };
  $('#gname').oninput = (e) => { draft.name = e.target.value; };
  view.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.preset) {
      draft.rules = presetRules(b.dataset.preset);
      rerenderNew();
    } else if (b.dataset.add) {
      addDraftPlayer(b.dataset.add);
      rerenderNew();
    } else if (b.dataset.rename) {
      draft.renaming = +b.dataset.rename;
      rerenderNew();
      const input = $('[data-rename-input]');
      input?.focus();
      input?.select();
    } else if (b.dataset.remove) {
      const i = +b.dataset.remove;
      const pl = draft.players[i];
      if (draft.edit && pl.pid && hasScores(draft.edit, pl.pid) && !confirm(t('new.removeConfirm', { name: pl.name }))) return;
      draft.players.splice(i, 1);
      if (draft.firstDealer >= draft.players.length) draft.firstDealer = 0;
      rerenderNew();
    } else if (b.dataset.move) {
      const i = +b.dataset.move;
      const j = i + +b.dataset.dir;
      const [pl] = draft.players.splice(i, 1);
      draft.players.splice(j, 0, pl);
      if (draft.firstDealer === i) draft.firstDealer = j;
      else if (draft.firstDealer === j) draft.firstDealer = i;
      rerenderNew();
    } else if (b.dataset.dealer) {
      draft.firstDealer = +b.dataset.dealer;
      rerenderNew();
    } else if (b.dataset.rule && b.dataset.val) {
      draft.rules = { ...draft.rules, ...sanitizeRules({ [b.dataset.rule]: b.dataset.val }) };
      rerenderNew();
    }
  };
  view.onchange = (e) => {
    const el = e.target;
    if (!el.dataset.rule) return;
    const v = el.type === 'checkbox' ? el.checked : Math.trunc(Number(el.value) || 0);
    draft.rules = { ...draft.rules, ...sanitizeRules({ [el.dataset.rule]: v }) };
    rerenderNew();
  };
  $('.rules-editor').ontoggle = (e) => { draft.open = e.target.open; };
  $('#start').onclick = draft.edit ? saveEdit : startGame;
  const rename = $('[data-rename-input]');
  if (rename) {
    let done = false;
    const commit = (keep) => {
      if (done) return;
      done = true;
      const i = +rename.dataset.renameInput;
      const name = rename.value.trim().slice(0, 40);
      const key = name.toLocaleLowerCase();
      if (keep && name && !draft.players.some((p, j) => j !== i && p.name.toLocaleLowerCase() === key)) {
        draft.players[i].name = name;
      } else if (keep && name && name !== draft.players[i].name) {
        toast(t('new.nameTaken', { name }));
      }
      draft.renaming = null;
      rerenderNew();
    };
    rename.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    };
    rename.onblur = () => commit(true);
  }

  const input = $('#pname');
  const list = $('#suggest');
  let active = -1;
  const show = () => {
    const q = input.value.trim().toLocaleLowerCase();
    const starts = (c) => c.toLocaleLowerCase().startsWith(q);
    const matches = q ? candidates().filter((c) => c.toLocaleLowerCase().includes(q))
      .sort((a, b) => Number(starts(b)) - Number(starts(a))).slice(0, 6) : [];
    active = matches.length ? 0 : -1;
    list.innerHTML = matches.map((m, i) => `<li role="option" data-name="${esc(m)}" class="${i === active ? 'active' : ''}">${esc(m)}</li>`).join('');
    list.hidden = !matches.length;
  };
  input.oninput = show;
  input.onkeydown = (e) => {
    const items = $$('li', list);
    if (!items.length || list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.classList.toggle('active', i === active));
    } else if (e.key === 'Escape') {
      list.hidden = true;
      active = -1;
    }
  };
  // pointerdown, so it fires before the input loses focus.
  list.onpointerdown = (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    keepFocus(() => addDraftPlayer(li.dataset.name))();
  };
  $('#add-form').onsubmit = (e) => {
    e.preventDefault();
    const pick = !list.hidden && active >= 0 ? $$('li', list)[active]?.dataset.name : null;
    keepFocus(() => addDraftPlayer(pick ?? input.value))();
  };
  input.onblur = () => setTimeout(() => { list.hidden = true; }, 150);
}

// Whether a player has anything entered in this game.
function hasScores(gid, pid) {
  return state().games[gid]?.rounds.some((r) => [r.scores, r.bids, r.tricks].some((m) => m && pid in m)
    || r.contract?.kurtier === pid || r.contract?.partner === pid);
}

// Player ids for the draft: new names become players, renamed ones are
// renamed (for the whole game night).
function resolvePlayers() {
  const s = state();
  return draft.players.map((pl) => {
    if (pl.pid && s.players[pl.pid]) {
      if (s.players[pl.pid].name !== pl.name) {
        store.forgetPlayer(s.players[pl.pid].name);
        live.dispatch({ type: 'renamePlayer', pid: pl.pid, name: pl.name });
      }
      return pl.pid;
    }
    const pid = newId();
    live.dispatch({ type: 'addPlayer', pid, name: pl.name });
    return pid;
  });
}

function startGame() {
  if (!draft.players.length || playerProblem(draft.rules, draft.players.length)) return;
  const pids = resolvePlayers();
  const gid = newId();
  const name = draft.name.trim() || suggestedName(draft.rules);
  live.dispatch({ type: 'newGame', gid, name, rules: draft.rules, players: pids, firstDealer: draft.firstDealer });
  store.rememberPlayers(draft.players.map((pl) => pl.name));
  draft = null;
  location.replace(`#/s/${route.sid}/g/${gid}`);
}

function saveEdit() {
  const n = draft.players.length;
  if (!n || playerProblem(draft.rules, n)) return;
  const gid = draft.edit;
  const pids = resolvePlayers();
  // The marker was "deals now"; store it as the first dealer.
  const current = summarize(state().games[gid]).current;
  const firstDealer = (((draft.firstDealer - current) % n) + n) % n;
  live.dispatch({ type: 'updateGame', gid, name: draft.name.trim() || suggestedName(draft.rules), rules: draft.rules, players: pids, firstDealer });
  store.rememberPlayers(draft.players.map((pl) => pl.name));
  draft = null;
  location.replace(`#/s/${route.sid}/g/${gid}`);
}

// --- Game table ------------------------------------------------------------------

function cellHtml(game, row, pid) {
  const r = row.round;
  let sub = '';
  if (r.contract) {
    if (r.contract.kurtier === pid) sub = `<span class="role">${tt('am.kurtier')} ${r.contract.bid}</span>`;
    else if (r.contract.partner === pid) sub = `<span class="role">${tt('am.partner')}</span>`;
  } else if (r.bids && pid in r.bids) {
    sub = r.tricks ? `${r.bids[pid]}/${r.tricks[pid] ?? 0}${r.bids[pid] === r.tricks[pid] ? ' ✓' : ''}` : `${tt('table.bid')} ${r.bids[pid]}`;
  }
  if (!row.scores) return `<td class="pending"><span class="sub">${sub || '·'}</span></td>`;
  const v = row.scores[pid] ?? 0;
  let cls = v < 0 ? 'neg' : '';
  if (r.bids && r.tricks) cls += r.bids[pid] === r.tricks[pid] ? ' hit' : ' miss';
  return `<td class="${cls}"><span class="v">${fmt(v)}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</td>`;
}

function tableHtml(game, sum, { interactive = true } = {}) {
  const lead = new Set(sum.completed ? sum.leaders : []);
  const head = game.players.map((pid) => `<th scope="col" class="${lead.has(pid) ? 'lead' : ''}${sum.dealer === pid && !sum.done ? ' dealer' : ''}">
    <span class="pn">${esc(pname(pid))}</span>${sum.dealer === pid && !sum.done ? `<span class="deal-mark" title="${tt('game.dealer')}">${icon('cards')}</span>` : ''}</th>`).join('');
  const rows = sum.rows.map((row) => {
    const title = row.cards != null ? `${t('game.round', { n: row.index + 1 })} · ${t('game.cards', { n: row.cards })}` : t('game.round', { n: row.index + 1 });
    return `<tr${interactive ? ` data-rid="${esc(row.round.id)}" tabindex="0" aria-label="${tt('table.editRow', { n: row.index + 1 })}"` : ''} class="${row.scores ? '' : 'pending-row'}">
      <th scope="row" class="rn" title="${esc(title)}">${row.index + 1}</th>
      ${game.players.map((pid) => cellHtml(game, row, pid)).join('')}</tr>`;
  }).join('');
  const foot = game.players.map((pid) => `<td class="${lead.has(pid) ? 'lead' : ''}">
    <span class="v">${fmt(sum.totals[pid])}</span>${sum.completed ? `<span class="rank r${sum.ranks[pid]}">${sum.ranks[pid]}</span>` : ''}</td>`).join('');
  const cols = game.players.length + 1;
  const endLink = interactive && !sum.done && sum.completed ? `<button type="button" class="link end-link" id="end-game">${icon('flag')}${tt('menu.end')}</button>` : '';
  return `<table class="score">
    <thead><tr><th class="corner" scope="col">#</th>${head}</tr></thead>
    <tbody>${rows || `<tr class="empty-row"><td colspan="${cols}">${tt('table.empty')}</td></tr>`}
      <tr class="filler"><td colspan="${cols}">${endLink}</td></tr></tbody>
    <tfoot><tr><th scope="row" class="corner">Σ</th>${foot}</tr></tfoot>
  </table>`;
}

// A finished game shows its results; this remembers who flipped to the table.
const showTable = {};

// Podium for places 1–3 (ties share a medal) and the rest in a list. The
// podium is in rank order in the DOM; CSS puts 2nd left and 3rd right.
function resultsHtml(game, sum) {
  const medal = (rank) => ['🥇', '🥈', '🥉'][rank - 1] ?? '';
  const top = sum.sorted.slice(0, 3);
  const rest = sum.sorted.slice(3);
  return `<section class="results" aria-labelledby="res-title">
    <h2 id="res-title">${tt('results.title')}</h2>
    <ol class="podium">${top.map((pid, i) => `
      <li class="place pos${i + 1} rank${Math.min(sum.ranks[pid], 3)}">
        <span class="medal" aria-hidden="true">${medal(sum.ranks[pid])}</span>
        <span class="place-name">${esc(pname(pid))}</span>
        <span class="place-score">${fmt(sum.totals[pid])}</span>
        <span class="place-step"><span class="sr">${tt('results.place', { n: sum.ranks[pid] })}</span><span aria-hidden="true">${sum.ranks[pid]}</span></span>
      </li>`).join('')}</ol>
    ${rest.length ? `<ol class="rest">${rest.map((pid) => `
      <li><span class="rest-rank">${sum.ranks[pid]}</span><span class="rest-name">${esc(pname(pid))}</span><span class="rest-score">${fmt(sum.totals[pid])}</span></li>`).join('')}</ol>` : ''}
    <p class="muted center small">${tt(sum.completed === 1 ? 'results.round1' : 'results.rounds', { n: sum.completed })}</p>
  </section>`;
}

const EDIT_HINT = 'scorepad-hint-edit-v1';

function infoHtml(game, sum) {
  if (sum.done) {
    return `<div class="winner">🏆 ${tt('game.won', { names: names(sum.winners) })} <span class="muted">${fmt(sum.totals[sum.winners[0]] ?? 0)}</span></div>`;
  }
  const parts = [];
  parts.push(sum.totalRounds ? tt('game.roundOf', { n: sum.current + 1, of: sum.totalRounds }) : tt('game.round', { n: sum.current + 1 }));
  if (sum.cards != null) parts.push(tt(entryOf(game) === 'contract' ? 'game.tricks' : 'game.cards', { n: sum.cards }));
  if (sum.dealer) parts.push(`${tt('game.dealer')}: <strong>${esc(pname(sum.dealer))}</strong>`);
  let extra = '';
  const r = sum.pending;
  const target = rulesOf(game).target;
  if (r?.bids) {
    extra = bidsLine(game, r.bids, sum.current);
  } else if (r?.contract) {
    const c = r.contract;
    extra = tt('am.contractLine', { k: pname(c.kurtier), bid: c.bid, p: c.partner ? pname(c.partner) : t('am.alone') });
  } else if (sum.completed && route.name === 'game' && !localStorage.getItem(EDIT_HINT)) {
    extra = tt('game.editHint');
  } else if (sum.completed) {
    const leader = sum.sorted[0];
    extra = target > 0
      ? tt('game.leadsTarget', { names: names(sum.leaders), score: fmt(sum.totals[leader]), left: Math.max(0, target - sum.totals[leader]), target })
      : tt('game.leads', { names: names(sum.leaders), score: fmt(sum.totals[leader]) });
  }
  return `<div class="info-line">${parts.join(' · ')}</div>${extra ? `<div class="info-line sub">${extra}</div>` : ''}`;
}

// Bids so far: "3 av 5 har meldt" until everyone has, then the balance.
function bidsLine(game, bids, index) {
  const n = game.players.filter((pid) => Number.isInteger(bids?.[pid])).length;
  if (n < game.players.length) return tt('bids.progress', { n, of: game.players.length });
  const bal = bidBalance(game, bids, index);
  let sum = 0;
  for (const pid of game.players) sum += bids[pid];
  if (bal == null) return tt('bids.sum', { n: sum });
  const word = bal > 0 ? tt('bids.over', { n: bal }) : bal < 0 ? tt('bids.under', { n: -bal }) : tt('bids.even');
  return `${tt('bids.sum', { n: sum })} · <span class="bal ${bal === 0 ? 'even' : bal > 0 ? 'over' : 'under'}">${word}</span>`;
}

function primaryAction(game, sum) {
  if (game.ended) return null;
  if (sum.totalRounds != null && sum.completed >= sum.totalRounds) return null;
  const entry = entryOf(game);
  if (entry === 'scores') return { label: t('act.newRound'), mode: 'scores' };
  if (entry === 'contract') return sum.pending ? { label: t('act.tricks'), mode: 'atricks' } : { label: t('act.contract'), mode: 'contract' };
  return sum.pending ? { label: t('act.tricks'), mode: 'tricks' } : { label: t('act.bids'), mode: 'bids' };
}

function renderGame() {
  const game = state().games[route.gid];
  view.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/s/${route.sid}" data-i18n-title="nav.back">${icon('back')}</a>
      <h1>${esc(gameName(game))}</h1>
      ${chipSlot()}
      <button type="button" class="icon-btn" id="game-menu" data-i18n-title="game.menu">${icon('dots')}</button>
    </header>
    <div class="game-info" id="gi"></div>
    <div class="table-wrap" id="tw"><div class="table-scroll" id="gt"></div></div>
    <footer class="action-bar" id="ga"></footer>`;
  applyI18n(view);
  $('#game-menu').onclick = openGameMenu;
  const gt = $('#gt');
  gt.onclick = (e) => {
    const tr = e.target.closest('tr[data-rid]');
    if (tr) openRound('edit', tr.dataset.rid);
  };
  gt.onkeydown = (e) => {
    const tr = e.target.closest('tr[data-rid]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openRound('edit', tr.dataset.rid);
    }
  };
  gt.onscroll = edgeFade;
  updateGame(true);
  // A round left half-entered (closed by accident, or a reload) comes back.
  const saved = loadSheetDraft();
  if (saved?.gid === game.id && saved.sid === route.sid) openRound(saved.req, saved.editing ? saved.rid : undefined);
}

// Hints that more players are off to the right.
function edgeFade() {
  const sc = $('#gt');
  if (sc) $('#tw').classList.toggle('more-right', sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 4);
}

function updateGame(first = false) {
  const game = state().games[route.gid];
  if (!game) return go(`#/s/${route.sid}`);
  const sum = summarize(game);
  $('#gi').innerHTML = infoHtml(game, sum);
  const scroller = $('#gt');
  const results = sum.done && !showTable[game.id];
  const wasResults = $('#tw').classList.contains('is-results');
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
  scroller.innerHTML = results ? resultsHtml(game, sum) : tableHtml(game, sum);
  $('#tw').classList.toggle('is-results', results);
  // Follow new rounds, like a pad filling up; results start at the top.
  if (results) {
    if (!wasResults) scroller.scrollTop = 0;
  } else if (first || atBottom || wasResults) scroller.scrollTop = scroller.scrollHeight;
  edgeFade();
  $('#end-game')?.addEventListener('click', () => endGame(game));
  if (sum.done) {
    $('#ga').innerHTML = `
      ${game.rounds.length && !game.ended ? `<button type="button" class="btn icon-only" id="undo" data-i18n-title="act.undo">${icon('undo')}</button>` : ''}
      <button type="button" class="btn" id="flip">${icon(results ? 'table' : 'trophy')}${tt(results ? 'act.showTable' : 'act.showResults')}</button>
      <a class="btn primary big grow" href="#/s/${route.sid}/new?from=${game.id}">${tt('act.again')}</a>`;
    applyI18n($('#ga'));
    $('#flip').onclick = () => {
      showTable[game.id] = results;
      updateGame();
    };
  } else {
    const act = primaryAction(game, sum);
    $('#ga').innerHTML = `
      ${game.rounds.length ? `<button type="button" class="btn" id="undo">${icon('undo')}${tt('act.undo')}</button>` : ''}
      ${act ? `<button type="button" class="btn primary big grow" id="primary">${esc(act.label)}</button>` : ''}`;
    if (act) $('#primary').onclick = () => openRound(act.mode);
  }
  $('#undo')?.addEventListener('click', undo);
}

function endGame(game) {
  if (!confirm(t('menu.endConfirm'))) return;
  showTable[game.id] = false;
  live.dispatch({ type: 'endGame', gid: game.id, ended: true });
}

function undo() {
  const game = state().games[route.gid];
  const last = game.rounds.at(-1);
  if (!last) return;
  const scored = !!scoreRound(game, last);
  if (scored && entryOf(game) !== 'scores') {
    // Back to "bids/contract entered, waiting for tricks".
    const { tricks, ...rest } = last;
    live.dispatch({ type: 'putRound', gid: game.id, round: rest });
  } else {
    live.dispatch({ type: 'deleteRound', gid: game.id, rid: last.id });
  }
  toast(t('undo.done'), { label: t('undo.redo'), run: () => live.dispatch({ type: 'putRound', gid: game.id, round: last }) });
}

// --- Round sheet -------------------------------------------------------------------
//
// One form for every kind of round. form.mode says what's entered: scores,
// bids, tricks, contract, atricks (contract tricks), or bids+tricks /
// contract+atricks with tabs. What you've typed is kept as a draft in
// localStorage until it's saved or discarded, so a stray tap, the back
// button or a reload can't lose it.

const SHEET_DRAFT = 'scorepad-sheet-v1';
const loadSheetDraft = () => {
  try {
    return JSON.parse(localStorage.getItem(SHEET_DRAFT));
  } catch {
    return null;
  }
};
const clearSheetDraft = () => localStorage.removeItem(SHEET_DRAFT);
function saveSheetDraft() {
  if (!form?.dirty) return;
  const { req, gid, rid, index, editing, mode, tab, scores, bids, tricks, contract, raw } = form;
  try {
    localStorage.setItem(SHEET_DRAFT, JSON.stringify({ sid: route.sid, req, gid, rid, index, editing, mode, tab, scores, bids, tricks, contract, raw }));
  } catch {
    // Storage full: the sheet still works, it just won't survive a reload.
  }
}

// Identifies what the sheet was opened on, to notice changes from elsewhere.
function sheetSig(game, rid) {
  return JSON.stringify([game.rounds.length, game.rounds.find((r) => r.id === rid) ?? null]);
}

function openRound(req, rid) {
  const game = state().games[route.gid];
  if (!game) return;
  const sum = summarize(game);
  let mode = req;
  let round = rid ? game.rounds.find((r) => r.id === rid) : mode === 'scores' || mode === 'bids' || mode === 'contract' ? null : sum.pending;
  if (rid && !round) return;
  if (!rid && (mode === 'tricks' || mode === 'atricks') && !round) return;
  const index = round ? game.rounds.indexOf(round) : game.rounds.length;
  const complete = round ? !!scoreRound(game, round) : false;
  if (mode === 'edit') {
    localStorage.setItem(EDIT_HINT, '1');
    mode = entryOf(game) === 'scores' ? 'scores'
      : entryOf(game) === 'contract' ? complete ? 'contract+atricks' : 'contract'
        : complete ? 'bids+tricks' : 'bids';
  }
  form = {
    req, mode, gid: game.id, index, editing: !!rid,
    rid: round?.id ?? newId(),
    tab: mode.includes('+') ? 'second' : null,
    scores: { ...round?.scores },
    bids: { ...round?.bids },
    tricks: { ...round?.tricks },
    contract: round?.contract ? { ...round.contract } : { kurtier: null, partner: undefined, bid: null },
    raw: {}, // Fritt: text as typed, to keep invalid input visible
    touched: {},
    dirty: false,
    tried: false,
    sig: sheetSig(game, round?.id),
  };
  const saved = loadSheetDraft();
  if (saved && saved.gid === game.id && saved.req === req && (rid ? saved.rid === rid : !saved.editing && saved.index === index)) {
    Object.assign(form, { mode: saved.mode, tab: saved.tab, scores: saved.scores, bids: saved.bids, tricks: saved.tricks, contract: saved.contract, raw: saved.raw ?? {}, dirty: true });
    if (!rid) form.rid = round?.id ?? saved.rid;
  } else if (saved && saved.gid === game.id) {
    clearSheetDraft();
  }
  // Most players make their bid: start the tricks from the bids, so only the
  // misses need a tap.
  if (form.mode === 'tricks' && !form.editing && !Object.keys(form.tricks).length) {
    form.tricks = { ...form.bids };
    form.prefilled = true;
  }
  renderSheet();
  if (!sheet.open) sheet.showModal();
  $('.sheet-body', sheet).scrollTop = 0;
  if (form.mode === 'scores' && !form.editing) {
    // Straight to typing, but not on top of a value that's already there.
    $$('[data-score]', sheet).find((el) => !el.value)?.focus();
  }
}

// Players in bidding order: left of the dealer first, dealer last. Every
// list in the sheet uses it, so rows never jump around between sheets.
function bidOrder(game, index) {
  const d = game.players.indexOf(dealerFor(game, index));
  return game.players.map((_, i) => game.players[(d + 1 + i) % game.players.length]);
}

// Number buttons from..to on an even grid: one row up to 7, then two (or
// three) balanced rows rather than a lonely last button.
function chipRow(group, pid, from, to, value, label) {
  const count = to - from + 1;
  const cols = count <= 7 ? count : count <= 14 ? Math.ceil(count / 2) : Math.ceil(count / 3);
  let html = '';
  for (let v = from; v <= to; v++) {
    const on = value === v;
    const pre = on && form.prefilled && group === 'tricks' && !form.touched[pid];
    html += `<button type="button" class="nchip${on ? ' on' : ''}${pre ? ' pre' : ''}" data-g="${group}" data-pid="${pid}" data-v="${v}" ${pressed(on)}>${v}</button>`;
  }
  return `<div class="nchips" style="--cols:${cols}" role="group" aria-label="${esc(label)}">${html}</div>`;
}

function sheetSections(game) {
  const f = form;
  const cards = cardsFor(game, f.index);
  const dealer = dealerFor(game, f.index);
  const totals = summarize(game).totals;
  const order = bidOrder(game, f.index);
  const out = [];
  const nameCell = (pid, more = '') => `<span class="pl"><span class="pl-name">${esc(pname(pid))}</span>${pid === dealer ? ` <span class="deal-mark" title="${tt('game.dealer')}">${icon('cards')}</span>` : ''}<span class="tot">Σ ${fmt(totals[pid] ?? 0)}</span>${more}</span>`;
  const maxN = cards ?? 13;
  const inline = maxN + 1 <= 5 ? '' : ' col';
  const both = f.mode.includes('+');
  const show = (part) => !both || (f.tab === 'first') === (part === 'first');

  if (both) {
    const [a, b] = f.mode === 'bids+tricks' ? ['sheet.bids', 'sheet.tricks'] : ['sheet.contractTitle', 'sheet.tricks'];
    out.push(`<div class="segmented tabs" role="tablist">
      <button type="button" role="tab" data-tab="first" class="${f.tab === 'first' ? 'on' : ''}" aria-selected="${f.tab === 'first'}">${tt(a)}</button>
      <button type="button" role="tab" data-tab="second" class="${f.tab === 'second' ? 'on' : ''}" aria-selected="${f.tab === 'second'}">${tt(b)}</button></div>`);
  }

  if (f.mode === 'scores') {
    out.push(`<div class="entry-list">${order.map((pid, i) => `
      <div class="entry" data-row="${pid}">${nameCell(pid)}
        <div class="stepper">
          <button type="button" class="step" data-step="-1" data-pid="${pid}" aria-label="${esc(pname(pid))} −1">−</button>
          <input type="text" inputmode="numeric" enterkeyhint="${i === order.length - 1 ? 'done' : 'next'}" autocomplete="off" class="num${f.raw[pid] != null && !Number.isInteger(f.scores[pid]) && f.raw[pid] !== '' ? ' invalid' : ''}" data-score="${pid}" value="${esc(f.raw[pid] ?? f.scores[pid] ?? '')}" aria-label="${esc(pname(pid))}">
          <button type="button" class="step" data-step="1" data-pid="${pid}" aria-label="${esc(pname(pid))} +1">+</button>
          <button type="button" class="step" data-neg="${pid}" aria-label="${esc(pname(pid))} ±">±</button>
        </div>
      </div>`).join('')}</div>`);
  }

  if (f.mode.startsWith('bids') && show('first')) {
    out.push(`<div class="entry-list">${order.map((pid) => `
      <div class="entry${inline}" data-row="${pid}">${nameCell(pid)}${chipRow('bids', pid, 0, maxN, f.bids[pid], `${pname(pid)}: ${t('sheet.bids')}`)}</div>`).join('')}</div>`);
    if (f.mode === 'bids' && !f.editing) {
      out.push(`<button type="button" class="link" id="both-at-once">${tt('sheet.bothAtOnce')}</button>`);
    }
  }

  if ((f.mode === 'tricks' || f.mode === 'bids+tricks') && show('second')) {
    out.push(`<div class="entry-list">${order.map((pid) => `
      <div class="entry${inline}" data-row="${pid}">${nameCell(pid, ` <span class="muted bidref">${tt('table.bid')} ${f.bids[pid] ?? '–'}</span><span class="preview" data-preview="${pid}"></span>`)}
      ${chipRow('tricks', pid, 0, maxN, f.tricks[pid], `${pname(pid)}: ${t('sheet.tricks')}`)}</div>`).join('')}</div>`);
  }

  if (f.mode.startsWith('contract') && show('first')) {
    const total = tricksTotal(game, f.index);
    const c = f.contract;
    out.push(`<h3>${tt('am.kurtier')}</h3><div class="pchips" role="group" aria-label="${tt('am.kurtier')}">${order.map((pid) =>
      `<button type="button" class="pchip${c.kurtier === pid ? ' on' : ''}" data-g="kurtier" data-pid="${pid}" ${pressed(c.kurtier === pid)}>${esc(pname(pid))}</button>`).join('')}</div>`);
    out.push(`<h3>${tt('am.bid')}</h3>${chipRow('bid', '', minBid(game, f.index), total, c.bid, t('am.bid'))}`);
    if (c.kurtier) {
      out.push(`<h3>${tt('am.partner')}</h3><div class="pchips" role="group" aria-label="${tt('am.partner')}">${order.filter((pid) => pid !== c.kurtier).map((pid) =>
        `<button type="button" class="pchip${c.partner === pid ? ' on' : ''}" data-g="partner" data-pid="${pid}" ${pressed(c.partner === pid)}>${esc(pname(pid))}</button>`).join('')}
        <button type="button" class="pchip${c.partner === null ? ' on' : ''}" data-g="partner" data-pid="" ${pressed(c.partner === null)}>${tt('am.alone')}</button></div>`);
    }
  }

  if (f.mode.endsWith('atricks') && show('second')) {
    const c = f.contract;
    const total = tricksTotal(game, f.index);
    if (c.kurtier && Number.isInteger(c.bid)) out.push(`<p class="contract-line">${tt('am.contractLine', { k: pname(c.kurtier), bid: c.bid, p: c.partner ? pname(c.partner) : t('am.alone') })}</p>`);
    if (c.kurtier && c.partner !== undefined) {
      out.push(`<h3>${tt('am.othersTricks')}</h3><div class="entry-list">${order.filter((pid) => pid !== c.kurtier && pid !== c.partner).map((pid) => `
        <div class="entry col" data-row="${pid}">${nameCell(pid)}${chipRow('tricks', pid, 0, total, f.tricks[pid], `${pname(pid)}: ${t('sheet.tricks')}`)}</div>`).join('')}</div>`);
    }
  }
  return out.join('');
}

// Fritt input: "−3", "+4", " 7 " are all fine.
function parseScore(raw) {
  const s = String(raw).replace(/[−–—]/g, '-').replace(/\s+/g, '');
  if (s === '') return { empty: true };
  if (!/^[+-]?\d+$/.test(s)) return { invalid: true };
  return { value: Math.max(-100000, Math.min(100000, Number(s))) };
}

// Validity, the summary lines, which players are still missing (in table
// order) and which tab they're on.
function checkForm(game) {
  const f = form;
  const cards = cardsFor(game, f.index);
  const order = bidOrder(game, f.index);
  const missingOf = (obj, pids) => pids.filter((pid) => !Number.isInteger(obj[pid]));
  const lines = [];
  const missing = [];
  let missingTab = null;
  let ok = true;

  if (f.mode === 'scores') {
    const invalid = order.filter((pid) => f.raw[pid] != null && parseScore(f.raw[pid]).invalid);
    const filled = order.filter((pid) => Number.isInteger(f.scores[pid]));
    if (invalid.length) {
      ok = false;
      lines.push(`<span class="warn">${tt('sheet.invalid', { names: names(invalid) })}</span>`);
      missing.push(...invalid);
    } else if (!filled.length) {
      ok = false;
      missing.push(...order);
      if (f.tried) lines.push(tt('sheet.missing', { names: names(order) }));
    } else if (filled.length < order.length) {
      lines.push(tt('sheet.blankZero'));
    }
  }

  if (f.mode.startsWith('bids')) {
    const m = missingOf(f.bids, order);
    if (m.length) {
      ok = false;
      missing.push(...m);
      missingTab ??= 'first';
      if (f.tried || m.length < order.length) lines.push(tt('sheet.missingBids', { names: names(m) }));
    } else if (f.mode === 'bids') {
      lines.push(bidsLine(game, f.bids, f.index));
    }
  }

  if (f.mode === 'tricks' || f.mode === 'bids+tricks') {
    const m = missingOf(f.tricks, order);
    if (m.length) {
      ok = false;
      missing.push(...m);
      missingTab ??= 'second';
      if (f.tried || m.length < order.length) lines.push(tt('sheet.missingTricks', { names: names(m) }));
    } else if (cards != null) {
      let n = 0;
      for (const pid of order) n += f.tricks[pid];
      if (n !== cards) {
        ok = false;
        lines.push(`<span class="warn">${tt('tricks.mismatch', { n, cards })}</span>`);
      } else {
        lines.push(`<span class="okline">${tt('tricks.ok', { n, cards })}</span>`);
      }
    }
    if (f.prefilled && !Object.keys(f.touched).length) lines.unshift(tt('tricks.prefilled'));
  }

  if (f.mode.startsWith('contract')) {
    const c = f.contract;
    if (!c.kurtier || !Number.isInteger(c.bid) || c.partner === undefined) {
      ok = false;
      missingTab ??= 'first';
      lines.push(tt(c.kurtier && Number.isInteger(c.bid) ? 'am.pickPartner' : 'am.pick'));
    }
  }

  if (f.mode.endsWith('atricks') && f.contract.kurtier && f.contract.partner !== undefined) {
    const c = f.contract;
    const others = order.filter((pid) => pid !== c.kurtier && pid !== c.partner);
    const m = missingOf(f.tricks, others);
    if (m.length) {
      ok = false;
      missing.push(...m);
      missingTab ??= 'second';
      if (f.tried || m.length < others.length) lines.push(tt('sheet.missingTricks', { names: names(m) }));
    } else {
      const team = teamTricks(game, { contract: c, tricks: f.tricks }, f.index);
      if (team < 0) {
        ok = false;
        lines.push(`<span class="warn">${tt('am.tooMany', { n: tricksTotal(game, f.index) })}</span>`);
      } else {
        const key = (team >= c.bid ? 'am.made' : 'am.failed') + (c.partner ? '' : 'Alone');
        lines.push(`<span class="${team >= c.bid ? 'okline' : ''}">${tt(key, { n: team, bid: c.bid })}</span>`);
      }
    }
  }
  if (f.stale) {
    ok = false;
    lines.unshift(`<span class="warn">${tt('sheet.stale')}</span> <button type="button" class="link inline" id="sheet-refresh">${tt('sheet.refresh')}</button>`);
  }
  return { ok, lines, missing, missingTab };
}

function formRound(game) {
  const f = form;
  const r = { id: f.rid };
  if (f.mode === 'scores') {
    // Blank counts as 0.
    r.scores = Object.fromEntries(game.players.map((pid) => [pid, Number.isInteger(f.scores[pid]) ? f.scores[pid] : 0]));
  }
  if (f.mode.startsWith('bids') || (f.mode === 'tricks' && Object.keys(f.bids).length)) r.bids = f.bids;
  if (f.mode === 'tricks' || f.mode === 'bids+tricks') r.tricks = f.tricks;
  if (f.mode.startsWith('contract') || f.mode === 'atricks') r.contract = f.contract;
  if (f.mode.endsWith('atricks')) {
    const c = f.contract;
    r.tricks = Object.fromEntries(game.players.filter((pid) => pid !== c.kurtier && pid !== c.partner).map((pid) => [pid, f.tricks[pid]]));
  }
  return r;
}

function refreshSheet() {
  const game = state().games[form.gid];
  const { ok, lines, missing } = checkForm(game);
  $('#sheet-summary').innerHTML = lines.join('<br>');
  const save = $('#sheet-save');
  save.classList.toggle('is-disabled', !ok);
  save.setAttribute('aria-disabled', String(!ok));
  // The next row to fill gets a marker; after a save attempt, all the
  // missing ones are flagged.
  for (const row of $$('[data-row]', sheet)) {
    row.classList.toggle('next', row.dataset.row === missing[0]);
    row.classList.toggle('missing', form.tried && missing.includes(row.dataset.row));
  }
  // Per-player score preview while entering tricks.
  if (form.mode === 'tricks' || form.mode === 'bids+tricks') {
    for (const el of $$('[data-preview]', sheet)) {
      const pid = el.dataset.preview;
      const v = Number.isInteger(form.tricks[pid]) && Number.isInteger(form.bids[pid]) ? scoreRoundOne(game, pid) : null;
      el.textContent = v != null ? ` → ${signed(v)}` : '';
      el.className = `preview${v > 0 ? ' pos' : v < 0 ? ' neg' : ''}`;
    }
  }
  saveSheetDraft();
}

// One player's score for the round as entered so far.
function scoreRoundOne(game, pid) {
  const r = rulesOf(game);
  const bid = form.bids[pid];
  const got = form.tricks[pid];
  const off = Math.abs(got - bid);
  return (off === 0 ? r.hitBase + r.hitPerTrick * bid : -r.missPerTrick * off) + r.trickPoints * got;
}

function renderSheet() {
  const game = state().games[form.gid];
  const cards = cardsFor(game, form.index);
  const dealer = dealerFor(game, form.index);
  const bodyScroll = $('.sheet-body', sheet)?.scrollTop ?? 0;
  const title = { scores: 'sheet.round', bids: 'sheet.bidsTitle', tricks: 'sheet.tricksTitle', contract: 'sheet.contractTitle', atricks: 'sheet.tricksTitle' }[form.mode] ?? 'sheet.round';
  const meta = [cards != null && entryOf(game) === 'bids' ? tt('game.cards', { n: cards }) : '', dealer ? `${tt('game.dealer')}: ${esc(pname(dealer))}` : ''].filter(Boolean).join(' · ');
  sheet.setAttribute('aria-labelledby', 'sheet-title');
  sheet.innerHTML = `
    <form method="dialog" class="sheet-inner" id="sheet-form" novalidate>
      <header class="sheet-head">
        <div><h2 id="sheet-title">${tt(title, { n: form.index + 1 })}</h2><p class="muted">${[title === 'sheet.round' ? '' : tt('sheet.round', { n: form.index + 1 }), meta].filter(Boolean).join(' · ')}</p></div>
        <button type="button" class="icon-btn" id="sheet-close" data-i18n-title="nav.close">${icon('x')}</button>
      </header>
      <div class="sheet-body">${sheetSections(game)}</div>
      <footer class="sheet-foot">
        <p id="sheet-summary" class="summary" aria-live="polite"></p>
        <div class="row">
          ${form.editing ? `<button type="button" class="btn danger" id="sheet-delete">${icon('trash')}${tt('sheet.delete')}</button>` : ''}
          <button type="submit" class="btn primary big grow" id="sheet-save">${tt('sheet.save')}</button>
        </div>
      </footer>
    </form>`;
  applyI18n(sheet);
  $('.sheet-body', sheet).scrollTop = bodyScroll;
  refreshSheet();
}

// Another device changed the round this sheet is for: don't save on top of
// it blindly.
function checkStale() {
  const game = state().games[form.gid];
  if (!game) return closeSheet(true);
  if (!form.stale && sheetSig(game, form.editing || form.mode === 'tricks' || form.mode === 'atricks' ? form.rid : null) !== form.sig) {
    form.stale = true;
    refreshSheet();
  }
}

// Reopen on the current state, keeping what was entered.
function refreshStale() {
  const keep = { scores: form.scores, raw: form.raw, bids: form.bids, tricks: form.tricks, contract: form.contract };
  const { req, editing, rid } = form;
  const game = state().games[form.gid];
  const sum = summarize(game);
  const act = primaryAction(game, sum);
  if (editing && !game.rounds.some((r) => r.id === rid)) return closeSheet(true);
  openRound(editing ? req : act?.mode ?? req, editing ? rid : undefined);
  if (!form) return;
  for (const k of ['scores', 'raw', 'bids']) form[k] = { ...form[k], ...keep[k] };
  if (form.mode.includes('tricks')) form.tricks = { ...form.tricks, ...keep.tricks };
  if (form.mode.startsWith('contract')) form.contract = keep.contract;
  form.dirty = true;
  renderSheet();
}

// Closes the sheet; asks first if that would throw away entered values.
function requestClose() {
  if (form?.dirty && !confirm(t('sheet.discard'))) return;
  closeSheet(true);
}

function closeSheet(discard = false) {
  if (discard) clearSheetDraft();
  form = null;
  if (sheet.open) sheet.close();
}

sheet.addEventListener('cancel', (e) => {
  // Escape / Android back.
  e.preventDefault();
  requestClose();
});

sheet.addEventListener('click', (e) => {
  // The backdrop only closes an untouched sheet: a stray tap with a drink in
  // the other hand mustn't lose a round.
  if (e.target === sheet) {
    if (!form?.dirty) closeSheet(true);
    return;
  }
  const b = e.target.closest('button');
  if (!b || !form) return;
  if (b.id === 'sheet-close') return requestClose();
  if (b.id === 'sheet-refresh') return refreshStale();
  if (b.id === 'sheet-delete') {
    if (!confirm(t('sheet.deleteConfirm'))) return;
    const { gid, rid } = form;
    closeSheet(true);
    live.dispatch({ type: 'deleteRound', gid, rid });
    return;
  }
  if (b.id === 'both-at-once') {
    form.mode = 'bids+tricks';
    form.tab = 'first';
    form.dirty = true;
    return renderSheet();
  }
  if (b.dataset.tab) {
    form.tab = b.dataset.tab;
    // Entering tricks right after bids: start them from the bids.
    if (form.tab === 'second' && form.mode === 'bids+tricks' && !Object.keys(form.tricks).length) {
      form.tricks = { ...form.bids };
      form.prefilled = true;
    }
    renderSheet();
    $('.sheet-body', sheet).scrollTop = 0;
    return;
  }
  if (b.dataset.g) {
    const g = b.dataset.g;
    const v = Number(b.dataset.v);
    const pid = b.dataset.pid;
    form.dirty = true;
    if (g === 'bids' || g === 'tricks') {
      form[g][pid] = v;
      form.touched[pid] = true;
    } else if (g === 'bid') form.contract.bid = v;
    else if (g === 'kurtier') {
      form.contract.kurtier = pid;
      if (form.contract.partner === pid) form.contract.partner = undefined;
    } else if (g === 'partner') form.contract.partner = pid || null;
    if (g === 'kurtier' || g === 'partner') return renderSheet();
    autoFillLast(g);
    for (const x of $$(`[data-g="${g}"]${pid ? `[data-pid="${pid}"]` : ''}`, sheet)) {
      x.classList.toggle('on', x === b);
      x.classList.remove('pre');
      x.setAttribute('aria-pressed', String(x === b));
    }
    refreshSheet();
    if (g === 'bids' || g === 'tricks') advance(b, g);
    return;
  }
  if (b.dataset.step || b.dataset.neg) {
    const pid = b.dataset.pid ?? b.dataset.neg;
    const input = $(`[data-score="${pid}"]`, sheet);
    const cur = Number.isInteger(form.scores[pid]) ? form.scores[pid] : 0;
    form.scores[pid] = b.dataset.neg ? -cur : cur + Number(b.dataset.step);
    form.raw[pid] = String(form.scores[pid]);
    input.value = form.raw[pid];
    input.classList.remove('invalid');
    form.dirty = true;
    refreshSheet();
  }
});

// With the cards known, the last player's tricks are whatever is left.
function autoFillLast(g) {
  if (g !== 'tricks' || !(form.mode === 'tricks' || form.mode === 'bids+tricks') || form.prefilled) return;
  const game = state().games[form.gid];
  const cards = cardsFor(game, form.index);
  if (cards == null) return;
  const open = game.players.filter((pid) => !Number.isInteger(form.tricks[pid]));
  if (open.length !== 1) return;
  let taken = 0;
  for (const pid of game.players) taken += form.tricks[pid] ?? 0;
  const rest = cards - taken;
  if (rest >= 0 && rest <= cards) {
    form.tricks[open[0]] = rest;
    renderSheet();
  }
}

// After a tap, move on: scroll the next empty row into view, and once all
// bids are in (entering both), switch to the tricks tab.
function advance(b, g) {
  const rows = $$('.entry', sheet);
  const i = rows.findIndex((r) => r.contains(b));
  const next = rows.slice(i + 1).find((r) => !$('.nchip.on', r)) ?? rows[i + 1];
  next?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (g === 'bids' && form.mode === 'bids+tricks' && form.tab === 'first') {
    const game = state().games[form.gid];
    if (game.players.every((pid) => Number.isInteger(form.bids[pid]))) {
      form.tab = 'second';
      form.tricks = Object.keys(form.tricks).length ? form.tricks : { ...form.bids };
      form.prefilled = true;
      renderSheet();
      $('.sheet-body', sheet).scrollTop = 0;
    }
  }
}

sheet.addEventListener('input', (e) => {
  const pid = e.target.dataset.score;
  if (!pid) return;
  const p = parseScore(e.target.value);
  form.raw[pid] = e.target.value;
  form.scores[pid] = p.value;
  e.target.classList.toggle('invalid', !!p.invalid);
  form.dirty = true;
  refreshSheet();
});

sheet.addEventListener('keydown', (e) => {
  // Enter in a score field jumps to the next one, then saves.
  if (e.key !== 'Enter' || !e.target.dataset.score) return;
  e.preventDefault();
  const inputs = $$('[data-score]', sheet);
  const next = inputs[inputs.indexOf(e.target) + 1];
  if (next) next.focus();
  else $('#sheet-form').requestSubmit();
});

sheet.addEventListener('submit', (e) => {
  e.preventDefault();
  const game = state().games[form.gid];
  const { ok, missing, missingTab } = checkForm(game);
  if (!ok) {
    // Show what's missing instead of a dead button.
    form.tried = true;
    if (missingTab && form.tab && form.tab !== missingTab) {
      form.tab = missingTab;
      renderSheet();
    } else refreshSheet();
    const row = $(`[data-row="${missing[0]}"]`, sheet);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('input', row ?? sheet)?.focus?.();
    return;
  }
  const { gid } = form;
  const round = formRound(game);
  closeSheet(true);
  live.dispatch({ type: 'putRound', gid, round });
});

sheet.addEventListener('close', () => { form = null; });

// --- Game menu -------------------------------------------------------------------

function openDialog(kind, html, wire) {
  dlg.dataset.kind = kind;
  dlg.innerHTML = `<div class="dlg-inner">${html}</div>`;
  labelDialog();
  applyI18n(dlg);
  wire?.();
  if (!dlg.open) dlg.showModal();
}

function labelDialog() {
  const h = $('h2', dlg);
  if (h) h.id = 'dlg-title';
  dlg.setAttribute('aria-labelledby', 'dlg-title');
}

dlg.addEventListener('click', (e) => {
  if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
});

function openRules(game) {
  openDialog('rules', `
    <header class="dlg-head"><h2>${esc(gameName(game))}</h2><button type="button" class="icon-btn" data-close data-i18n-title="nav.close">${icon('x')}</button></header>
    <ul class="rules-summary">${rulesSummary(rulesOf(game)).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <button type="button" class="btn" id="m-edit">${icon('edit')}${tt('menu.edit')}</button>`, () => {
    $('#m-edit').onclick = () => { dlg.close(); go(`#/s/${route.sid}/g/${game.id}/edit`); };
  });
}

function openGameMenu() {
  const game = state().games[route.gid];
  const sum = summarize(game);
  const item = (id, ic, label, cls = '') => `<button type="button" class="menu-item ${cls}" id="${id}">${icon(ic)}<span>${esc(label)}</span></button>`;
  openDialog('menu', `
    <header class="dlg-head"><h2>${esc(gameName(game))}</h2><button type="button" class="icon-btn" data-close data-i18n-title="nav.close">${icon('x')}</button></header>
    <div class="menu">
      ${item('m-end', game.ended ? 'play' : 'flag', t(game.ended ? 'menu.reopen' : 'menu.end'))}
      ${item('m-rules', 'book', t('menu.rules'))}
      ${item('m-dash', 'tv', t('menu.dashboard'))}
      ${item('m-share', 'qr', t('session.share'))}
      ${sum.done ? item('m-again', 'plus', t('act.again')) : ''}
      ${item('m-settings', 'gear', t('settings.title'))}
      ${item('m-delete', 'trash', t('menu.delete'), 'danger')}
    </div>`, () => {
    $('#m-rules').onclick = () => openRules(game);
    $('#m-dash').onclick = () => { dlg.close(); go(`#/s/${route.sid}/g/${game.id}/dash`); };
    $('#m-share').onclick = () => openShare();
    $('#m-again')?.addEventListener('click', () => { dlg.close(); go(`#/s/${route.sid}/new?from=${game.id}`); });
    $('#m-end').onclick = () => {
      dlg.close();
      if (game.ended) live.dispatch({ type: 'endGame', gid: game.id, ended: false });
      else endGame(game);
    };
    $('#m-settings').onclick = () => openSettings();
    $('#m-delete').onclick = () => {
      if (!confirm(t('menu.deleteConfirm'))) return;
      live.dispatch({ type: 'deleteGame', gid: game.id });
      dlg.close();
      go(`#/s/${route.sid}`);
    };
  });
}

// --- Share ---------------------------------------------------------------------------

function openShare() {
  if (!live) return;
  dlg.dataset.kind = 'share';
  renderShare();
  if (!dlg.open) dlg.showModal();
}

function renderShare() {
  const head = `<header class="dlg-head"><h2>${tt('share.title')}</h2><button type="button" class="icon-btn" data-close data-i18n-title="nav.close">${icon('x')}</button></header>`;
  if (!live.shared) {
    dlg.innerHTML = `<div class="dlg-inner">${head}
      <p>${tt('share.intro')}</p>
      <p class="muted">${tt('share.expiry')}</p>
      <button type="button" class="btn primary big" id="do-share">${icon('qr')}${tt(live.rec.expired ? 'share.again' : 'share.start')}</button>
    </div>`;
    labelDialog();
    applyI18n(dlg);
    $('#do-share').onclick = async (e) => {
      e.target.disabled = true;
      try {
        await live.share();
        renderShare();
      } catch {
        e.target.disabled = false;
        toast(t('share.failed'));
      }
    };
    return;
  }
  const url = shareUrl(live.rec.code);
  dlg.innerHTML = `<div class="dlg-inner share">${head}
    ${qrSvg(url)}
    <p class="big-code">${esc(live.rec.code)}</p>
    <p class="muted center">${esc(url.replace(/^https?:\/\//, ''))}</p>
    <div class="row wrap center">
      <button type="button" class="btn" id="copy-link">${icon('copy')}${tt('share.copy')}</button>
      ${navigator.share ? `<button type="button" class="btn" id="native-share">${icon('share')}${tt('share.native')}</button>` : ''}
    </div>
    <p class="muted center small">${tt('share.expiry')}</p>
  </div>`;
  labelDialog();
  applyI18n(dlg);
  $('#copy-link').onclick = () => copyLink(url);
  $('#native-share')?.addEventListener('click', () => navigator.share({ title: t('app.name'), url }).catch(() => {}));
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast(t('share.copied'));
  } catch {
    prompt(t('share.copy'), url);
  }
}

// --- Settings --------------------------------------------------------------------------

function openSettings() {
  const themes = ['hytte', 'cozy', 'lys', 'mork', 'kontrast'];
  const recent = store.recentPlayers();
  openDialog('settings', `
    <header class="dlg-head"><h2>${tt('settings.title')}</h2><button type="button" class="icon-btn" data-close data-i18n-title="nav.close">${icon('x')}</button></header>
    <section>
      <h3>${tt('settings.lang')}</h3>
      <div class="segmented" role="group" aria-label="${tt('settings.lang')}">${['auto', 'no', 'en'].map((l) => `<button type="button" data-lang="${l}" class="${settings.lang === l ? 'on' : ''}" ${pressed(settings.lang === l)}>${tt(`settings.lang.${l}`)}</button>`).join('')}</div>
    </section>
    <section>
      <h3>${tt('settings.theme')}</h3>
      <div class="themes" role="group" aria-label="${tt('settings.theme')}">${themes.map((th) => `<button type="button" class="theme-swatch${settings.theme === th ? ' on' : ''}" data-theme-pick="${th}" ${pressed(settings.theme === th)}><span class="sw sw-${th}"></span>${tt(`theme.${th}`)}</button>`).join('')}</div>
    </section>
    <section>
      <label class="switch-row"><span>${tt('settings.wake')}</span><input type="checkbox" class="switch" id="wake"${settings.wake ? ' checked' : ''}></label>
    </section>
    <section id="conn"></section>
    <section>
      <h3>${tt('settings.data')}</h3>
      <div class="row wrap">
        ${live ? `<button type="button" class="btn" id="export">${icon('download')}${tt('settings.export')}</button>` : ''}
        <label class="btn">${icon('upload')}${tt('settings.import')}<input type="file" accept="application/json,.json" id="import" hidden></label>
      </div>
    </section>
    ${recent.length ? `<section>
      <h3>${tt('settings.recent')}</h3>
      <div class="chips">${recent.map((p) => `<button type="button" class="chip removable" data-forget="${esc(p.name)}" aria-label="${tt('settings.forget', { name: p.name })}">${esc(p.name)} ${icon('x')}</button>`).join('')}</div>
    </section>` : ''}
    <p class="muted small center">${tt('settings.about')}</p>`, () => {
    refreshConnection();
    for (const b of $$('[data-lang]', dlg)) b.onclick = () => { settings.lang = b.dataset.lang; saveAndApply(); openSettings(); render(); };
    for (const b of $$('[data-theme-pick]', dlg)) b.onclick = () => { settings.theme = b.dataset.themePick; saveAndApply(); openSettings(); };
    $('#wake').onchange = (e) => { settings.wake = e.target.checked; saveAndApply(); updateWake(); };
    $('#export')?.addEventListener('click', exportSession);
    $('#import').onchange = importSession;
    for (const b of $$('[data-forget]', dlg)) b.onclick = () => { store.forgetPlayer(b.dataset.forget); b.remove(); };
  });
}

function saveAndApply() {
  store.saveSettings(settings);
  applySettings();
}

// Connection section: only for a shared session. Devices are just screens, not players.
function refreshConnection() {
  const el = $('#conn', dlg);
  if (!el) return;
  if (!live?.shared) {
    el.innerHTML = live?.rec.expired ? `<h3>${tt('conn.title')}</h3><p class="muted">${tt('session.expired')}</p>` : '';
    el.hidden = !live?.rec.expired;
    return;
  }
  el.hidden = false;
  const me = store.deviceId();
  const devices = [...live.devices].sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.since - b.since));
  const pending = live.rec.pending.length;
  el.innerHTML = `
    <h3>${tt('conn.title')}</h3>
    <p class="conn-status"><span class="conn-dot status-${live.status}">${tt(`status.${live.status}`)}</span>
      ${pending ? `<span class="muted">${tt('conn.pending', { n: pending })}</span>` : ''}</p>
    <p>${tt('conn.code')}: <button type="button" class="link code" id="conn-share">${esc(live.rec.code)}</button></p>
    <h4>${tt('conn.devices', { n: devices.length })}</h4>
    <ul class="devices">${devices.map((d) => `<li>${icon('device')}<span>${esc(d.label || '?')}${d.id === me ? ` <span class="badge">${tt('conn.me')}</span>` : ''}</span><span class="muted">${tt('conn.since', { time: timeLabel(d.since) })}</span></li>`).join('') || `<li class="muted">${tt('conn.none')}</li>`}</ul>
    <p class="muted small">${tt('share.expiry')}</p>
    <div class="row wrap"><button type="button" class="btn" id="conn-copy">${icon('copy')}${tt('share.copy')}</button></div>
    <div class="row wrap"><button type="button" class="btn danger" id="conn-leave">${tt('conn.leave')}</button></div>`;
  $('#conn-share').onclick = openShare;
  $('#conn-copy').onclick = () => copyLink(shareUrl(live.rec.code));
  $('#conn-leave').onclick = () => {
    if (!confirm(t('conn.leaveConfirm'))) return;
    live.leave();
    refreshConnection();
    render();
  };
}

function exportSession() {
  const data = { app: 'scorepad', version: 1, createdAt: live.rec.createdAt, events: [...live.rec.events, ...live.rec.pending] };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `poengblokka-${new Date(live.rec.createdAt).toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importSession(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== 'scorepad' || !Array.isArray(data.events)) throw new Error('format');
    const rec = store.newSession({ events: data.events });
    if (Number.isFinite(data.createdAt)) {
      rec.createdAt = data.createdAt;
      store.saveSession(rec);
    }
    dlg.close();
    go(`#/s/${rec.id}`);
  } catch {
    toast(t('settings.importFailed'));
  }
}

// --- Big screen ------------------------------------------------------------------------

function dashGame() {
  const s = state();
  if (route.gid && s.games[route.gid]) return s.games[route.gid];
  // Follow whichever game was touched last.
  return s.gameOrder.map((id) => s.games[id]).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
}

function renderDash() {
  const game = dashGame();
  const qr = live.shared ? `<div class="dash-qr">${qrSvg(shareUrl(live.rec.code))}<span>${esc(live.rec.code)}</span></div>` : '';
  const exit = route.gid ? `#/s/${route.sid}/g/${route.gid}` : `#/s/${route.sid}`;
  if (!game) {
    view.innerHTML = `<div class="dash"><header class="dash-head"><div><h1>${tt('app.name')}</h1><p>${tt('dash.waiting')}</p></div>
      <a class="icon-btn exit" href="${exit}" data-i18n-title="dash.exit">${icon('x')}</a></header><div class="dash-empty">${qr}</div></div>`;
    applyI18n(view);
    return;
  }
  const sum = summarize(game);
  const last = [...sum.rows].reverse().find((r) => r.scores);
  const r = sum.pending;
  const sub = (pid) => {
    if (r?.bids && pid in r.bids) return `<span class="pill">${tt('table.bid')} ${r.bids[pid]}</span>`;
    if (r?.contract?.kurtier === pid) return `<span class="pill">${tt('am.kurtier')} · ${r.contract.bid}</span>`;
    if (r?.contract?.partner === pid) return `<span class="pill">${tt('am.partner')}</span>`;
    return '';
  };
  const max = Math.max(1, ...game.players.map((pid) => Math.abs(sum.totals[pid])));
  const board = sum.sorted.map((pid) => {
    const bumped = prevTotals[`${game.id}:${pid}`] !== undefined && prevTotals[`${game.id}:${pid}`] !== sum.totals[pid];
    prevTotals[`${game.id}:${pid}`] = sum.totals[pid];
    const delta = last?.scores?.[pid];
    return `<li class="${sum.completed && sum.ranks[pid] === 1 ? 'lead' : ''}${bumped ? ' bump' : ''}" style="--w:${Math.max(0, sum.totals[pid]) / max}">
      <span class="d-rank">${sum.completed ? sum.ranks[pid] : ''}</span>
      <span class="d-name">${esc(pname(pid))}${sum.dealer === pid && !sum.done ? ` <span class="deal-mark">${icon('cards')}</span>` : ''} ${sub(pid)}</span>
      <span class="d-delta">${delta != null ? signed(delta) : ''}</span>
      <span class="d-total">${fmt(sum.totals[pid])}</span>
    </li>`;
  }).join('');
  view.innerHTML = `
    <div class="dash">
      <header class="dash-head">
        <div class="grow"><h1>${esc(gameName(game))}</h1><div class="dash-info">${infoHtml(game, sum)}</div></div>
        ${qr}
        <a class="icon-btn exit" href="${exit}" data-i18n-title="dash.exit">${icon('x')}</a>
      </header>
      <div class="dash-body">
        <div class="dash-side">
          ${sum.done ? resultsHtml(game, sum) : `${last ? `<p class="board-legend">${tt('dash.lastRound')}</p>` : ''}
          <ol class="board">${board}</ol>`}
        </div>
        <div class="dash-table table-scroll">${tableHtml(game, sum, { interactive: false })}</div>
      </div>
    </div>`;
  applyI18n(view);
  const tbl = $('.dash-table');
  tbl.scrollTop = tbl.scrollHeight;
}

// --- Boot ---------------------------------------------------------------------------------

async function boot() {
  applySettings();
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9]{6})\/?$/);
  if (m) {
    const dash = new URLSearchParams(location.search).get('view') === 'dashboard';
    history.replaceState(null, '', '/');
    view.innerHTML = `<main class="page"><p class="empty">${tt('join.joining')}</p></main>`;
    if (!(await join(m[1], dash))) render();
    return;
  }
  render();
}

boot();

// Secure context covers https and localhost (so local testing exercises it).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
