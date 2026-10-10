// Poengblokka / Scorepad UI. Plain DOM, hash routing, no framework.
//
// Routes:  #/                 home
//          #/s/:sid           session (its games)
//          #/s/:sid/new       new game (?from=:gid prefills)
//          #/s/:sid/g/:gid    game table
//          #/s/:sid/g/:gid/edit  change name and rules
//          #/s/:sid/dash      dashboard, follows the active game
//          #/s/:sid/g/:gid/dash  dashboard pinned to one game
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
let prevTotals = {}; // dashboard bump animation

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
const signed = (n) => (n > 0 ? `+${n}` : fmt(n));

function dateLabel(ms) {
  const d = new Date(ms);
  const s = new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const timeLabel = (ms) => new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

// --- Helpers -------------------------------------------------------------------

const state = () => live?.state;
const pname = (pid) => state()?.players[pid]?.name ?? '?';
const names = (pids) => pids.map(pname).join(', ');
const gameName = (g) => g.name || t('game.untitled');
const entryOf = (g) => rulesOf(g).entry;

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
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3000);
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

function statusChip() {
  if (!live?.shared) return '';
  return `<button type="button" class="status-chip status-${live.status}" data-act="share" title="${tt(`status.${live.status}`)}"><span class="dot"></span>${esc(live.rec.code)}</button>`;
}

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
  for (const el of $$('.status-chip')) el.outerHTML = statusChip();
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
  if (sheet.open && (prev.gid !== route.gid || route.name !== 'game')) sheet.close();
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

function sessionSummary(rec) {
  const s = (live?.rec.id === rec.id ? live.state : null) ?? reduceRec(rec);
  const games = s.gameOrder.length;
  const players = s.playerOrder.slice(0, 6).map((pid) => s.players[pid].name);
  return { games, players };
}

const reduceRec = (rec) => reduce([...rec.events, ...rec.pending]);

function renderHome() {
  // "New game" makes a record up front; drop the ones abandoned before a game
  // was started (never shared, nothing in them).
  for (const rec of store.listSessions()) {
    if (!rec.code && !rec.events.length && !rec.pending.length) store.deleteSession(rec.id);
  }
  const sessions = store.listSessions();
  const [latest, ...older] = sessions;
  const item = (rec, cls = '') => {
    const { games, players } = sessionSummary(rec);
    return `<a class="card session-card ${cls}" href="#/s/${rec.id}">
      <span class="session-date">${esc(dateLabel(rec.createdAt))}${rec.code && !rec.expired ? ` <span class="badge">${tt('session.shared')}</span>` : ''}</span>
      <span class="session-meta">${tt(games === 1 ? 'session.game' : 'session.games', { n: games })}${players.length ? ` · ${esc(players.join(', '))}` : ''}</span>
    </a>`;
  };
  view.innerHTML = `
    <header class="hero">
      <div class="hero-top"><span></span><button type="button" class="icon-btn" data-act="settings" data-i18n-title="settings.title">${icon('gear')}</button></div>
      <h1>${tt('app.name')}</h1>
      <p>${tt('app.tagline')}</p>
    </header>
    <main class="page">
      <div class="stack">
        <button type="button" class="btn primary big" id="new-session">${icon('plus')}${tt('home.new')}</button>
        ${latest ? `<section><h2>${tt('home.continue')}</h2>${item(latest, 'latest')}</section>` : ''}
        <section class="card join">
          <h2>${tt('home.join')}</h2>
          <form id="join-form" class="row">
            <input id="join-code" class="code-input" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="K7QX4M" aria-label="${tt('home.code')}">
            <button class="btn">${tt('home.joinBtn')}</button>
          </form>
          <p class="hint">${tt('home.joinHint')}</p>
        </section>
        ${older.length ? `<section><h2>${tt('home.earlier')}</h2><div class="stack tight">${older.slice(0, 30).map((r) => item(r)).join('')}</div></section>` : ''}
      </div>
    </main>`;
  applyI18n(view);
  $('#new-session').onclick = () => {
    const rec = store.newSession();
    go(`#/s/${rec.id}/new`);
  };
  $('#join-form').onsubmit = (e) => {
    e.preventDefault();
    join($('#join-code').value);
  };
}

// True if it navigated to the session.
async function join(raw, dash = false) {
  const code = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return toast(t('join.bad')), false;
  const target = (rec) => `#/s/${rec.id}${dash ? '/dash' : ''}`;
  const existing = store.findByCode(code);
  if (existing) return go(target(existing)), true;
  let ok;
  try {
    ok = await store.sessionExists(code);
  } catch {
    return toast(t('join.offline')), false;
  }
  if (!ok) return toast(t('join.missing')), false;
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
    const progress = sum.totalRounds ? tt('game.roundOf', { n: Math.min(sum.completed, sum.totalRounds), of: sum.totalRounds }) : tt('game.rounds', { n: sum.completed });
    return `<a class="card game-card${sum.done ? ' done' : ''}" href="#/s/${route.sid}/g/${g.id}">
      <span class="game-card-top"><strong>${esc(gameName(g))}</strong><span class="muted">${progress}</span></span>
      <span class="game-card-players">${esc(names(g.players))}</span>
      <span class="game-card-lead">${lead}</span>
    </a>`;
  };
  view.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="#/" data-i18n-title="nav.home">${icon('back')}</a>
      <h1>${esc(dateLabel(live.rec.createdAt))}</h1>
      ${statusChip()}
      <button type="button" class="icon-btn" data-act="settings" data-i18n-title="settings.title">${icon('gear')}</button>
    </header>
    <main class="page">
      <div class="stack">
        ${live.rec.expired ? `<p class="notice">${tt('session.expired')}</p>` : ''}
        <div class="row wrap">
          <a class="btn primary" href="#/s/${route.sid}/new">${icon('plus')}${tt('session.newGame')}</a>
          <button type="button" class="btn" data-act="share">${icon('qr')}${tt('session.share')}</button>
          <a class="btn" href="#/s/${route.sid}/dash">${icon('tv')}${tt('session.dashboard')}</a>
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

function initDraft() {
  const s = state();
  if (route.edit) {
    const g = s.games[route.edit];
    draft = { edit: g.id, name: g.name, rules: rulesOf(g), players: [], firstDealer: 0 };
    return;
  }
  const from = s.games[route.from] ?? s.games[s.gameOrder.at(-1)];
  if (from) {
    draft = {
      name: from.name,
      rules: rulesOf(from),
      players: from.players.map((pid) => ({ pid, name: pname(pid) })),
      firstDealer: route.from ? (from.firstDealer + 1) % from.players.length : 0,
    };
  } else {
    draft = { name: '', rules: presetRules('selbuvist'), players: [], firstDealer: 0 };
  }
}

// What an unnamed game is called: its preset, or "Own rules".
const suggestedName = (rules) => {
  const p = matchPreset(rules);
  return p ? t(`preset.${p}`) : t('rules.ownName');
};

// The rules in plain words, one line per rule that matters.
function rulesSummary(r) {
  const lines = [t(`sum.entry.${r.entry}`)];
  if (r.entry !== 'scores') {
    const rounds = r.cards === 'updown' || r.cards === 'downup' ? r.maxCards * 2 : 0;
    lines.push(t(`sum.cards.${r.cards}`, { max: r.maxCards, n: rounds }));
  }
  if (r.entry === 'bids') {
    const hit = [r.hitBase || '', r.hitPerTrick ? `${r.hitPerTrick === 1 ? '' : `${r.hitPerTrick} × `}${t('sum.bid')}` : ''].filter(Boolean).join(' + ') || '0';
    lines.push(t('sum.hit', { hit }));
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
  if (r.rounds > 0) lines.push(t('sum.rounds', { n: r.rounds }));
  if (r.target > 0) lines.push(t('sum.target', { n: r.target }));
  lines.push(t(r.lowWins ? 'sum.low' : 'sum.high'));
  return lines;
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
  return `<div class="field-col"><span>${label}</span><div class="segmented">${opts.map((o) =>
    `<button type="button" data-rule="${key}" data-val="${o}" class="${r[key] === o ? 'on' : ''}">${tt(`rule.${key}.${o}`)}</button>`).join('')}</div></div>`;
}

function ruleFields() {
  const r = draft.rules;
  const groups = [['entry']];
  if (r.entry !== 'scores') {
    groups.push(['cards', ...(['updown', 'downup', 'fixed'].includes(r.cards) ? ['maxCards'] : [])]);
  }
  if (r.entry === 'bids') groups.push(['hitBase', 'hitPerTrick', 'missPerTrick', 'trickPoints']);
  if (r.entry === 'contract') groups.push(['fail', 'othersPerTrick', 'doubleKurtier', 'halfPartner', 'minHalf', 'allTricksWins']);
  groups.push(['rounds', 'target', 'lowWins']);
  return groups.map((keys) => `<div class="rule-group">${keys.map(ruleField).join('')}</div>`).join('');
}

function renderNew() {
  if (!draft) initDraft();
  const r = draft.rules;
  const editing = !!draft.edit;
  const preset = matchPreset(r);
  const n = draft.players.length;
  const problem = editing ? null : playerProblem(r, n);
  const chips = editing ? [] : candidates().slice(0, 14);
  const back = editing ? `#/s/${route.sid}/g/${draft.edit}` : `#/s/${route.sid}`;
  view.innerHTML = `
    <header class="bar">
      <a class="icon-btn" href="${back}" data-i18n-title="nav.back">${icon('back')}</a>
      <h1>${tt(editing ? 'new.editTitle' : 'new.title')}</h1>
      <button type="button" class="icon-btn" data-act="settings" data-i18n-title="settings.title">${icon('gear')}</button>
    </header>
    <main class="page">
      <div class="stack">
        <section>
          <h2>${tt('new.name')}</h2>
          <input id="gname" class="text-input" maxlength="40" autocomplete="off" value="${esc(draft.name)}" placeholder="${esc(suggestedName(r))}">
        </section>

        <section>
          <h2>${tt('new.rules')}</h2>
          <div class="presets" role="radiogroup" aria-label="${tt('new.presets')}">
            ${PRESET_IDS.map((id) => `<button type="button" role="radio" aria-checked="${id === preset}" class="preset${id === preset ? ' on' : ''}" data-preset="${id}">${esc(t(`preset.${id}`))}</button>`).join('')}
            ${preset ? '' : `<span class="preset own on" role="radio" aria-checked="true">${tt('rules.own')}</span>`}
          </div>
          <div class="card rules-card">
            <ul class="rules-summary">${rulesSummary(r).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
            ${SOURCES[preset] ? `<p class="small muted">${SOURCES[preset]}</p>` : ''}
            <details class="rules-editor"${draft.open ? ' open' : ''}>
              <summary>${tt('new.customize')}</summary>
              ${ruleFields()}
            </details>
          </div>
        </section>

        ${editing ? `<p class="hint">${tt('new.editHint')}</p>` : `<section>
          <h2>${tt('new.playersTitle')} <span class="muted">${n}</span></h2>
          ${n ? `<ol class="seats">${draft.players.map((pl, i) => `
            <li>
              <span class="seat-no">${i + 1}</span>
              <span class="seat-name">${esc(pl.name)}</span>
              <button type="button" class="dealer-btn${i === draft.firstDealer ? ' on' : ''}" data-dealer="${i}" title="${tt('new.dealsFirst')}">${i === draft.firstDealer ? tt('new.dealer') : icon('cards')}</button>
              <button type="button" class="icon-btn small" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} data-i18n-title="new.up">${icon('up')}</button>
              <button type="button" class="icon-btn small" data-move="${i}" data-dir="1" ${i === n - 1 ? 'disabled' : ''} data-i18n-title="new.down">${icon('down')}</button>
              <button type="button" class="icon-btn small" data-remove="${i}" data-i18n-title="new.remove">${icon('x')}</button>
            </li>`).join('')}</ol>` : ''}
          <form class="add-player" id="add-form" autocomplete="off">
            <div class="combo">
              <input id="pname" enterkeyhint="done" maxlength="40" placeholder="${tt('new.addPlaceholder')}" aria-autocomplete="list" aria-controls="suggest" autocapitalize="words">
              <ul id="suggest" class="suggest" role="listbox" hidden></ul>
            </div>
            <button class="btn" aria-label="${tt('new.add')}">${icon('plus')}</button>
          </form>
          ${chips.length ? `<div class="chips">${chips.map((c) => `<button type="button" class="chip" data-add="${esc(c)}">+ ${esc(c)}</button>`).join('')}</div>` : ''}
          ${problem && n ? `<p class="hint warn">${tt(problem.key, problem)}</p>` : ''}
        </section>`}
      </div>
    </main>
    <footer class="action-bar">
      <button type="button" class="btn primary big" id="start" ${editing || (n && !problem) ? '' : 'disabled'}>${tt(editing ? 'new.save' : 'new.start')}</button>
    </footer>`;
  applyI18n(view);
  wireNew();
}

function candidates() {
  const s = state();
  const taken = new Set(draft.players.map((p) => p.name.toLocaleLowerCase()));
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
    } else if (b.dataset.remove) {
      const i = +b.dataset.remove;
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
  if (draft.edit) return;

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

function startGame() {
  if (!draft.players.length || playerProblem(draft.rules, draft.players.length)) return;
  const s = state();
  const pids = draft.players.map((pl) => {
    if (pl.pid && s.players[pl.pid]) return pl.pid;
    const pid = newId();
    live.dispatch({ type: 'addPlayer', pid, name: pl.name });
    return pid;
  });
  const gid = newId();
  const name = draft.name.trim() || suggestedName(draft.rules);
  live.dispatch({ type: 'newGame', gid, name, rules: draft.rules, players: pids, firstDealer: draft.firstDealer });
  store.rememberPlayers(draft.players.map((pl) => pl.name));
  draft = null;
  location.replace(`#/s/${route.sid}/g/${gid}`);
}

function saveEdit() {
  const gid = draft.edit;
  live.dispatch({ type: 'updateGame', gid, name: draft.name.trim() || suggestedName(draft.rules), rules: draft.rules });
  draft = null;
  location.replace(`#/s/${route.sid}/g/${gid}`);
}

// --- Game table ------------------------------------------------------------------

function cellHtml(game, row, pid) {
  const r = row.round;
  let sub = '';
  if (r.contract) {
    if (r.contract.kurtier === pid) sub = `<span class="role">${tt('am.k')} ${r.contract.bid}</span>`;
    else if (r.contract.partner === pid) sub = `<span class="role">${tt('am.p')}</span>`;
    else if (r.tricks) sub = '';
  } else if (r.bids && pid in r.bids) {
    sub = r.tricks ? `${r.bids[pid]}/${r.tricks[pid] ?? 0}` : `${tt('table.bid')} ${r.bids[pid]}`;
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
  const rows = sum.rows.map((row) => `<tr${interactive ? ` data-rid="${esc(row.round.id)}" tabindex="0"` : ''} class="${row.scores ? '' : 'pending-row'}">
    <th scope="row" class="rn">${row.index + 1}${row.cards != null && entryOf(game) === 'bids' ? `<small>${row.cards}</small>` : ''}</th>
    ${game.players.map((pid) => cellHtml(game, row, pid)).join('')}</tr>`).join('');
  const foot = game.players.map((pid) => `<td class="${lead.has(pid) ? 'lead' : ''}">
    <span class="v">${fmt(sum.totals[pid])}</span>${sum.completed ? `<span class="rank r${sum.ranks[pid]}">${sum.ranks[pid]}</span>` : ''}</td>`).join('');
  return `<table class="score">
    <thead><tr><th class="corner" scope="col">#</th>${head}</tr></thead>
    <tbody>${rows || `<tr class="empty-row"><td colspan="${game.players.length + 1}">${tt('table.empty')}</td></tr>`}</tbody>
    <tfoot><tr><th scope="row" class="corner">Σ</th>${foot}</tr></tfoot>
  </table>`;
}

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
  if (r?.bids) {
    const bal = bidBalance(game, r.bids, sum.current);
    if (bal != null) extra = balanceHtml(bal, game, r.bids);
  } else if (r?.contract) {
    const c = r.contract;
    extra = tt('am.contractLine', { k: pname(c.kurtier), bid: c.bid, p: c.partner ? pname(c.partner) : t('am.alone') });
  }
  return `<div class="info-line">${parts.join(' · ')}</div>${extra ? `<div class="info-line sub">${extra}</div>` : ''}`;
}

function balanceHtml(bal, game, bids) {
  let sum = 0;
  for (const pid of game.players) sum += bids?.[pid] ?? 0;
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
      ${statusChip()}
      <button type="button" class="icon-btn" id="game-menu" data-i18n-title="game.menu">${icon('dots')}</button>
    </header>
    <div class="game-info" id="gi"></div>
    <div class="table-scroll" id="gt"></div>
    <footer class="action-bar" id="ga"></footer>`;
  applyI18n(view);
  $('#game-menu').onclick = openGameMenu;
  $('#gt').onclick = (e) => {
    const tr = e.target.closest('tr[data-rid]');
    if (tr) openRound('edit', tr.dataset.rid);
  };
  $('#gt').onkeydown = (e) => {
    const tr = e.target.closest('tr[data-rid]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openRound('edit', tr.dataset.rid);
    }
  };
  updateGame(true);
}

function updateGame(first = false) {
  const game = state().games[route.gid];
  if (!game) return go(`#/s/${route.sid}`);
  const sum = summarize(game);
  $('#gi').innerHTML = infoHtml(game, sum);
  const scroller = $('#gt');
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
  scroller.innerHTML = tableHtml(game, sum);
  // Follow new rounds, like a pad filling up.
  if (first || atBottom) scroller.scrollTop = scroller.scrollHeight;
  const act = primaryAction(game, sum);
  $('#ga').innerHTML = `
    ${game.rounds.length && !game.ended ? `<button type="button" class="btn" id="undo">${icon('undo')}${tt('act.undo')}</button>` : ''}
    ${act ? `<button type="button" class="btn primary big grow" id="primary">${esc(act.label)}</button>` : ''}
    ${sum.done ? `<a class="btn primary grow" href="#/s/${route.sid}/new?from=${game.id}">${tt('act.again')}</a>` : ''}`;
  if (act) $('#primary').onclick = () => openRound(act.mode);
  $('#undo')?.addEventListener('click', undo);
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

function openRound(mode, rid) {
  const game = state().games[route.gid];
  const sum = summarize(game);
  let round = rid ? game.rounds.find((r) => r.id === rid) : mode === 'scores' || mode === 'bids' || mode === 'contract' ? null : sum.pending;
  if (rid && !round) return;
  const index = round ? game.rounds.indexOf(round) : game.rounds.length;
  if (mode === 'edit') {
    const complete = !!scoreRound(game, round);
    mode = entryOf(game) === 'scores' ? 'scores'
      : entryOf(game) === 'contract' ? complete ? 'contract+atricks' : 'contract'
        : complete ? 'bids+tricks' : 'bids';
  }
  form = {
    mode, gid: game.id, index, editing: !!rid,
    rid: round?.id ?? newId(),
    scores: { ...round?.scores },
    bids: { ...round?.bids },
    tricks: { ...round?.tricks },
    contract: round?.contract ? { ...round.contract } : { kurtier: null, partner: undefined, bid: null },
  };
  renderSheet();
  sheet.showModal();
  $('.sheet-body', sheet).scrollTop = 0;
}

// Players in bidding order: left of the dealer first, dealer last.
function bidOrder(game, index) {
  const d = game.players.indexOf(dealerFor(game, index));
  return game.players.map((_, i) => game.players[(d + 1 + i) % game.players.length]);
}

function chipRow(group, pid, from, to, value, extra = '') {
  let html = '';
  for (let v = from; v <= to; v++) html += `<button type="button" class="nchip${value === v ? ' on' : ''}" data-g="${group}" data-pid="${pid}" data-v="${v}">${v}</button>`;
  return `<div class="nchips${extra}">${html}</div>`;
}

function sheetSections(game) {
  const f = form;
  const cards = cardsFor(game, f.index);
  const dealer = dealerFor(game, f.index);
  const out = [];
  const nameCell = (pid, more = '') => `<span class="pl">${esc(pname(pid))}${pid === dealer ? ` <span class="deal-mark" title="${tt('game.dealer')}">${icon('cards')}</span>` : ''}${more}</span>`;
  const maxN = cards ?? 13;

  if (f.mode === 'scores') {
    out.push(`<div class="entry-list">${game.players.map((pid) => `
      <div class="entry">${nameCell(pid)}
        <div class="stepper">
          <button type="button" class="step" data-step="-1" data-pid="${pid}" aria-label="−1">−</button>
          <input type="text" inputmode="numeric" pattern="-?[0-9]*" class="num" data-score="${pid}" value="${f.scores[pid] ?? ''}" aria-label="${esc(pname(pid))}">
          <button type="button" class="step" data-step="1" data-pid="${pid}" aria-label="+1">+</button>
          <button type="button" class="step" data-neg="${pid}" aria-label="±">±</button>
        </div>
      </div>`).join('')}</div>`);
  }

  if (f.mode.startsWith('bids')) {
    out.push(`${f.mode.includes('+') ? `<h3>${tt('sheet.bids')}</h3>` : ''}<div class="entry-list">${bidOrder(game, f.index).map((pid) => `
      <div class="entry col">${nameCell(pid)}${chipRow('bids', pid, 0, maxN, f.bids[pid])}</div>`).join('')}</div>`);
  }

  if (f.mode.endsWith('tricks') && !f.mode.endsWith('atricks')) {
    out.push(`${f.mode.includes('+') ? `<h3>${tt('sheet.tricks')}</h3>` : ''}<div class="entry-list">${game.players.map((pid) => `
      <div class="entry col">${nameCell(pid, ` <span class="muted">· ${tt('table.bid')} ${f.bids[pid] ?? '–'}</span><span class="preview" data-preview="${pid}"></span>`)}
      ${chipRow('tricks', pid, 0, maxN, f.tricks[pid])}</div>`).join('')}</div>`);
  }

  if (f.mode.startsWith('contract')) {
    const total = tricksTotal(game, f.index);
    const c = f.contract;
    out.push(`<h3>${tt('am.kurtier')}</h3><div class="pchips">${game.players.map((pid) =>
      `<button type="button" class="pchip${c.kurtier === pid ? ' on' : ''}" data-g="kurtier" data-pid="${pid}">${esc(pname(pid))}</button>`).join('')}</div>`);
    out.push(`<h3>${tt('am.bid')}</h3>${chipRow('bid', '', minBid(game, f.index), total, c.bid, ' wrap')}`);
    if (c.kurtier) {
      out.push(`<h3>${tt('am.partner')}</h3><div class="pchips">${game.players.filter((pid) => pid !== c.kurtier).map((pid) =>
        `<button type="button" class="pchip${c.partner === pid ? ' on' : ''}" data-g="partner" data-pid="${pid}">${esc(pname(pid))}</button>`).join('')}
        <button type="button" class="pchip${c.partner === null ? ' on' : ''}" data-g="partner" data-pid="">${tt('am.alone')}</button></div>`);
    }
  }

  if (f.mode.endsWith('atricks')) {
    const c = f.contract;
    const total = tricksTotal(game, f.index);
    if (f.mode === 'atricks') out.push(`<p class="contract-line">${tt('am.contractLine', { k: pname(c.kurtier), bid: c.bid, p: c.partner ? pname(c.partner) : t('am.alone') })}</p>`);
    if (c.kurtier && c.partner !== undefined) {
      out.push(`<h3>${tt('am.othersTricks')}</h3><div class="entry-list">${game.players.filter((pid) => pid !== c.kurtier && pid !== c.partner).map((pid) => `
        <div class="entry col">${nameCell(pid)}${chipRow('tricks', pid, 0, total, f.tricks[pid])}</div>`).join('')}</div>`);
    }
  }
  return out.join('');
}

// Validity + summary line for the current form.
function checkForm(game) {
  const f = form;
  const cards = cardsFor(game, f.index);
  const all = (obj, pids) => pids.every((pid) => Number.isInteger(obj[pid]));
  const lines = [];
  let ok = true;

  if (f.mode === 'scores') {
    ok = all(f.scores, game.players);
    if (!ok) lines.push(t('sheet.fillAll'));
  }
  if (f.mode.startsWith('bids')) {
    if (!all(f.bids, game.players)) ok = false;
    const bal = bidBalance(game, f.bids, f.index);
    if (bal != null && Object.keys(f.bids).length) {
      lines.push(balanceHtml(bal, game, f.bids));
    }
  }
  if (f.mode.endsWith('tricks') && !f.mode.endsWith('atricks')) {
    if (!all(f.tricks, game.players)) ok = false;
    if (cards != null) {
      let n = 0;
      for (const pid of game.players) n += f.tricks[pid] ?? 0;
      if (all(f.tricks, game.players) && n !== cards) {
        ok = false;
        lines.push(`<span class="warn">${tt('tricks.mismatch', { n, cards })}</span>`);
      }
    }
  }
  if (f.mode.startsWith('contract')) {
    const c = f.contract;
    if (!c.kurtier || !Number.isInteger(c.bid) || c.partner === undefined) {
      ok = false;
      lines.push(t('am.pick'));
    }
  }
  if (f.mode.endsWith('atricks') && f.contract.kurtier && f.contract.partner !== undefined) {
    const c = f.contract;
    const others = game.players.filter((pid) => pid !== c.kurtier && pid !== c.partner);
    if (!all(f.tricks, others)) ok = false;
    else {
      const team = teamTricks(game, { contract: c, tricks: f.tricks }, f.index);
      if (team < 0) {
        ok = false;
        lines.push(`<span class="warn">${tt('am.tooMany', { n: tricksTotal(game, f.index) })}</span>`);
      } else {
        lines.push(tt(team >= c.bid ? 'am.made' : 'am.failed', { n: team, bid: c.bid }));
      }
    }
  }
  return { ok, lines };
}

function formRound(game) {
  const f = form;
  const r = { id: f.rid };
  if (f.mode === 'scores') r.scores = f.scores;
  if (f.mode.startsWith('bids') || (f.mode === 'tricks' && Object.keys(f.bids).length)) r.bids = f.bids;
  if (f.mode.includes('tricks') && !f.mode.endsWith('atricks')) r.tricks = f.tricks;
  if (f.mode.startsWith('contract') || f.mode === 'atricks') r.contract = f.contract;
  if (f.mode.endsWith('atricks')) {
    const c = f.contract;
    r.tricks = Object.fromEntries(game.players.filter((pid) => pid !== c.kurtier && pid !== c.partner).map((pid) => [pid, f.tricks[pid]]));
  }
  return r;
}

function refreshSheet() {
  const game = state().games[form.gid];
  const { ok, lines } = checkForm(game);
  $('#sheet-summary').innerHTML = lines.join('<br>');
  $('#sheet-save').disabled = !ok;
  // Per-player score preview while entering tricks.
  if (form.mode.includes('tricks') && !form.mode.endsWith('atricks')) {
    const scores = (() => {
      try {
        return scoreRound(game, formRound(game), form.index);
      } catch {
        return null;
      }
    })();
    for (const el of $$('[data-preview]', sheet)) {
      const v = scores?.[el.dataset.preview];
      el.textContent = Number.isInteger(v) && Number.isInteger(form.tricks[el.dataset.preview]) ? ` → ${signed(v)}` : '';
      el.className = `preview${v > 0 ? ' pos' : v < 0 ? ' neg' : ''}`;
    }
  }
}

function renderSheet() {
  const game = state().games[form.gid];
  const cards = cardsFor(game, form.index);
  const dealer = dealerFor(game, form.index);
  const bodyScroll = $('.sheet-body', sheet)?.scrollTop ?? 0;
  const title = { scores: 'sheet.round', bids: 'sheet.bidsTitle', tricks: 'sheet.tricksTitle', contract: 'sheet.contractTitle', atricks: 'sheet.tricksTitle' }[form.mode] ?? 'sheet.round';
  const meta = [cards != null && entryOf(game) === 'bids' ? tt('game.cards', { n: cards }) : '', dealer ? `${tt('game.dealer')}: ${esc(pname(dealer))}` : ''].filter(Boolean).join(' · ');
  sheet.innerHTML = `
    <form method="dialog" class="sheet-inner" id="sheet-form">
      <header class="sheet-head">
        <div><h2>${tt(title, { n: form.index + 1 })}</h2><p class="muted">${[title === 'sheet.round' ? '' : tt('sheet.round', { n: form.index + 1 }), meta].filter(Boolean).join(' · ')}</p></div>
        <button type="button" class="icon-btn" id="sheet-close" data-i18n-title="nav.close">${icon('x')}</button>
      </header>
      <div class="sheet-body">${sheetSections(game)}</div>
      <footer class="sheet-foot">
        <p id="sheet-summary" class="summary"></p>
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

sheet.addEventListener('click', (e) => {
  if (e.target === sheet) return sheet.close(); // backdrop
  const b = e.target.closest('button');
  if (!b || !form) return;
  if (b.id === 'sheet-close') return sheet.close();
  if (b.id === 'sheet-delete') {
    if (!confirm(t('sheet.deleteConfirm'))) return;
    live.dispatch({ type: 'deleteRound', gid: form.gid, rid: form.rid });
    sheet.close();
    return;
  }
  if (b.dataset.g) {
    const g = b.dataset.g;
    const v = Number(b.dataset.v);
    if (g === 'bids' || g === 'tricks') form[g][b.dataset.pid] = v;
    else if (g === 'bid') form.contract.bid = v;
    else if (g === 'kurtier') {
      form.contract.kurtier = b.dataset.pid;
      if (form.contract.partner === b.dataset.pid) form.contract.partner = undefined;
    } else if (g === 'partner') form.contract.partner = b.dataset.pid || null;
    if (g === 'kurtier' || g === 'partner') return renderSheet();
    for (const x of $$(`[data-g="${g}"]${b.dataset.pid ? `[data-pid="${b.dataset.pid}"]` : ''}`, sheet)) x.classList.toggle('on', x === b);
    refreshSheet();
    // Move on to the next row, so a round is a quick series of taps.
    if (g === 'bids' || g === 'tricks') {
      const rows = $$('.entry', sheet);
      const i = rows.findIndex((r) => r.contains(b));
      rows[i + 1]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    return;
  }
  if (b.dataset.step || b.dataset.neg) {
    const pid = b.dataset.pid ?? b.dataset.neg;
    const input = $(`[data-score="${pid}"]`, sheet);
    const cur = Number.isInteger(form.scores[pid]) ? form.scores[pid] : 0;
    form.scores[pid] = b.dataset.neg ? -cur : cur + Number(b.dataset.step);
    input.value = form.scores[pid];
    refreshSheet();
  }
});

sheet.addEventListener('input', (e) => {
  const pid = e.target.dataset.score;
  if (!pid) return;
  const raw = e.target.value.replace(/[−–]/g, '-').trim();
  form.scores[pid] = /^-?\d+$/.test(raw) ? Math.max(-100000, Math.min(100000, Number(raw))) : undefined;
  refreshSheet();
});

sheet.addEventListener('keydown', (e) => {
  // Enter in a score field jumps to the next one, then submits.
  if (e.key !== 'Enter' || !e.target.dataset.score) return;
  e.preventDefault();
  const inputs = $$('[data-score]', sheet);
  const next = inputs[inputs.indexOf(e.target) + 1];
  if (next) next.focus();
  else if (!$('#sheet-save').disabled) $('#sheet-form').requestSubmit();
});

sheet.addEventListener('submit', (e) => {
  e.preventDefault();
  const game = state().games[form.gid];
  if (!checkForm(game).ok) return;
  live.dispatch({ type: 'putRound', gid: form.gid, round: formRound(game) });
  sheet.close();
});

sheet.addEventListener('close', () => { form = null; });

// --- Game menu -------------------------------------------------------------------

function openDialog(kind, html, wire) {
  dlg.dataset.kind = kind;
  dlg.innerHTML = `<div class="dlg-inner">${html}</div>`;
  applyI18n(dlg);
  wire?.();
  if (!dlg.open) dlg.showModal();
}

dlg.addEventListener('click', (e) => {
  if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
});

function openGameMenu() {
  const game = state().games[route.gid];
  const item = (id, ic, label, cls = '') => `<button type="button" class="menu-item ${cls}" id="${id}">${icon(ic)}<span>${esc(label)}</span></button>`;
  openDialog('menu', `
    <header class="dlg-head"><h2>${esc(gameName(game))}</h2><button type="button" class="icon-btn" data-close data-i18n-title="nav.close">${icon('x')}</button></header>
    <div class="menu">
      ${item('m-dash', 'tv', t('menu.dashboard'))}
      ${item('m-share', 'qr', t('session.share'))}
      ${item('m-again', 'plus', t('act.again'))}
      ${item('m-end', game.ended ? 'play' : 'flag', t(game.ended ? 'menu.reopen' : 'menu.end'))}
      ${item('m-rules', 'book', t('new.rules'))}
      ${item('m-edit', 'edit', t('menu.edit'))}
      ${item('m-settings', 'gear', t('settings.title'))}
      ${item('m-delete', 'trash', t('menu.delete'), 'danger')}
    </div>`, () => {
    $('#m-dash').onclick = () => { dlg.close(); go(`#/s/${route.sid}/g/${game.id}/dash`); };
    $('#m-share').onclick = () => openShare();
    $('#m-again').onclick = () => { dlg.close(); go(`#/s/${route.sid}/new?from=${game.id}`); };
    $('#m-end').onclick = () => { live.dispatch({ type: 'endGame', gid: game.id, ended: !game.ended }); dlg.close(); };
    $('#m-rules').onclick = () => openDialog('rules', `
      <header class="dlg-head"><h2>${esc(gameName(game))}</h2><button type="button" class="icon-btn" data-close data-i18n-title="nav.close">${icon('x')}</button></header>
      <ul class="rules-summary">${rulesSummary(rulesOf(game)).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <button type="button" class="btn" id="m-edit2">${icon('edit')}${tt('menu.edit')}</button>`, () => {
      $('#m-edit2').onclick = () => { dlg.close(); go(`#/s/${route.sid}/g/${game.id}/edit`); };
    });
    $('#m-edit').onclick = () => { dlg.close(); go(`#/s/${route.sid}/g/${game.id}/edit`); };
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
  applyI18n(dlg);
  $('#copy-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast(t('share.copied'));
    } catch {
      prompt(t('share.copy'), url);
    }
  };
  $('#native-share')?.addEventListener('click', () => navigator.share({ title: t('app.name'), url }).catch(() => {}));
}

// --- Settings --------------------------------------------------------------------------

function openSettings() {
  const themes = ['hytte', 'lys', 'mork', 'kontrast'];
  const recent = store.recentPlayers();
  openDialog('settings', `
    <header class="dlg-head"><h2>${tt('settings.title')}</h2><button type="button" class="icon-btn" data-close data-i18n-title="nav.close">${icon('x')}</button></header>
    <section>
      <h3>${tt('settings.lang')}</h3>
      <div class="segmented">${['auto', 'no', 'en'].map((l) => `<button type="button" data-lang="${l}" class="${settings.lang === l ? 'on' : ''}">${tt(`settings.lang.${l}`)}</button>`).join('')}</div>
    </section>
    <section>
      <h3>${tt('settings.theme')}</h3>
      <div class="themes">${themes.map((th) => `<button type="button" class="theme-swatch${settings.theme === th ? ' on' : ''}" data-theme-pick="${th}"><span class="sw sw-${th}"></span>${tt(`theme.${th}`)}</button>`).join('')}</div>
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
      <div class="chips">${recent.map((p) => `<button type="button" class="chip removable" data-forget="${esc(p.name)}">${esc(p.name)} ${icon('x')}</button>`).join('')}</div>
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
    <p class="conn-status"><span class="conn-dot status-${live.status}"><span class="dot"></span>${tt(`status.${live.status}`)}</span>
      ${pending ? `<span class="muted">${tt('conn.pending', { n: pending })}</span>` : ''}</p>
    <p>${tt('conn.code')}: <button type="button" class="link code" id="conn-share">${esc(live.rec.code)}</button></p>
    <h4>${tt('conn.devices', { n: devices.length })}</h4>
    <ul class="devices">${devices.map((d) => `<li>${icon('device')}<span>${esc(d.label || '?')}${d.id === me ? ` <span class="badge">${tt('conn.me')}</span>` : ''}</span><span class="muted">${tt('conn.since', { time: timeLabel(d.since) })}</span></li>`).join('') || `<li class="muted">${tt('conn.none')}</li>`}</ul>
    <p class="muted small">${tt('share.expiry')}</p>
    <div class="row wrap">
      <button type="button" class="btn" id="conn-copy">${icon('copy')}${tt('share.copy')}</button>
      <button type="button" class="btn danger" id="conn-leave">${tt('conn.leave')}</button>
    </div>`;
  $('#conn-share').onclick = openShare;
  $('#conn-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl(live.rec.code));
      toast(t('share.copied'));
    } catch {
      prompt(t('share.copy'), shareUrl(live.rec.code));
    }
  };
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

// --- Dashboard -------------------------------------------------------------------------

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
        <div><h1>${esc(gameName(game))}</h1><div class="dash-info">${infoHtml(game, sum)}</div></div>
        <a class="icon-btn exit" href="${exit}" data-i18n-title="dash.exit">${icon('x')}</a>
      </header>
      <div class="dash-body">
        <ol class="board">${board}</ol>
        <div class="dash-table table-scroll">${tableHtml(game, sum, { interactive: false })}</div>
      </div>
      ${qr}
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
