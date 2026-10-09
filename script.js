'use strict';
/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = n => `<svg class="i"><use href="#${n}"/></svg>`;
const DAY = 864e5, OPEN = 96, TRASH_DAYS = 30, APP_VERSION = '1.0', SCHEMA = 2;

/* ---------- storage: IndexedDB (fallback: localStorage) ---------- */
const LS = 'nexus2.';
const lsGet = (k, f) => { try { return JSON.parse(localStorage.getItem(LS + k)) ?? f; } catch { return f; } };
const lsSet = (k, v) => localStorage.setItem(LS + k, JSON.stringify(v)); // may throw (quota / blocked)
let notes = [], tasks = [], trash = [], ready = false;
let board = { items: [], arrows: [], view: { x: 0, y: 0, z: 1 } };
let settings = { theme: 'light', lang: 'en', sort: 'new', vibrate: true, accent: 'violet', anim: true, vib: { checks: true, del: true, save: true }, ...lsGet('settings', {}) };

const store = {
  mode: 'idb', db: null,
  async init() {
    try {
      if (!window.indexedDB) throw 0;
      this.db = await new Promise((ok, no) => {
        const r = indexedDB.open('nexus', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); r.onblocked = () => no(new Error('blocked'));
      });
    } catch { this.mode = 'ls'; }
  },
  get(k) {
    if (this.mode === 'ls') return Promise.resolve(lsGet(k));
    return new Promise((ok, no) => { const r = this.db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  },
  set(k, v) {
    if (this.mode === 'ls') return new Promise((ok, no) => { try { lsSet(k, v); ok(); } catch (e) { no(e); } });
    return new Promise((ok, no) => {
      const tx = this.db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k);
      tx.oncomplete = ok; tx.onerror = tx.onabort = () => no(tx.error);
    });
  }
};
let locked = false;
const save = (...ks) => { if (locked) return; const m = { notes, tasks, trash, board }; Promise.all(ks.map(k => store.set(k, m[k]))).catch(storageError); };
const saveSettings = () => { try { lsSet('settings', settings); } catch (e) { storageError(e); } };
function storageError(e) {
  console.error('Storage error:', e);
  $('#bannerMsg').textContent = t('storageErr'); $('#banner').hidden = false;
}
$('#bannerX').addEventListener('click', () => { $('#banner').hidden = true; });

/* ---------- data schema + migrations ---------- */
const MIGRATIONS = {
  2(d) { // v1 -> v2: normalise records, fold legacy checklist items of notes into the text
    d.notes = d.notes.filter(n => n && typeof n === 'object').map(n => {
      const c = cleanNote(n);
      if (Array.isArray(n.items) && n.items.length)
        c.text = [c.text, ...n.items.map(i => `${i && i.done ? '☑' : '☐'} ${(i && i.text) || ''}`)].filter(Boolean).join('\n');
      return c;
    });
    d.tasks = d.tasks.filter(k => k && typeof k === 'object').map(cleanTask);
    d.trash = d.trash.filter(x => x && x.item && typeof x.item === 'object').map(x => ({
      tid: String(x.tid || uid()), kind: x.kind === 'task' ? 'task' : 'note',
      item: x.kind === 'task' ? cleanTask(x.item) : cleanNote(x.item), deletedAt: Number(x.deletedAt) || Date.now()
    }));
  }
};
async function migrate() {
  const meta = await store.get('meta');
  const empty = !notes.length && !tasks.length && !trash.length;
  const from = meta && meta.schema ? meta.schema : (empty ? SCHEMA : 1);
  if (from > SCHEMA) { // data written by a newer app version: protect it
    locked = true; $('#bannerMsg').textContent = t('newerData'); $('#banner').hidden = false; return;
  }
  if (from === SCHEMA) { if (!meta) await store.set('meta', { schema: SCHEMA }); return; }
  await store.set('backup_v' + from, { notes, tasks, trash, at: Date.now() }); // safety copy before changing anything
  const d = { notes, tasks, trash };
  for (let v = from + 1; v <= SCHEMA; v++) MIGRATIONS[v](d);
  ({ notes, tasks, trash } = d);
  await Promise.all([store.set('notes', notes), store.set('tasks', tasks), store.set('trash', trash), store.set('meta', { schema: SCHEMA })]);
}

async function boot() {
  await store.init();
  try {
    let n = await store.get('notes'), k = await store.get('tasks'), tr = await store.get('trash');
    if (store.mode === 'idb' && n === undefined && k === undefined) { // one-time move from localStorage
      n = lsGet('notes', []); k = lsGet('tasks', []); notes = n; tasks = k;
      await Promise.all([store.set('notes', n), store.set('tasks', k)]);
      localStorage.removeItem(LS + 'notes'); localStorage.removeItem(LS + 'tasks');
    }
    notes = Array.isArray(n) ? n : []; tasks = Array.isArray(k) ? k : []; trash = Array.isArray(tr) ? tr : [];
    await migrate();
    board = BD.clean(await store.get('board'));
  } catch (e) { storageError(e); }
  const keep = trash.filter(x => x.deletedAt > Date.now() - TRASH_DAYS * DAY);
  if (keep.length !== trash.length) { trash = keep; save('trash'); }
  ready = true; BD.mount(); renderAll(); stagger('notes');
  if (location.hash === '#/sheet') history.replaceState(null, '', '#/');
  route();
  Promise.resolve(navigator.storage?.persist?.()).catch(() => {});
}

/* ---------- i18n (UI only, user content is never translated) ---------- */
const L = {
  en: { myNotes: 'My notes', searchPh: 'Search notes…', newNote: 'New note', tasks: 'Tasks', addTask: 'Add task', settings: 'Settings',
    theme: 'Theme', accent: 'Accent color', about: 'About LUMO', animations: 'Animations', newTask: 'New task', wordW: ['word', 'words'], minRead: 'min read', aVersion: 'Version', aSchema: 'Data schema', aNotes: 'Notes', aTasks: 'Tasks', aTrash: 'In trash', aSize: 'Data size', aStore: 'Storage', aBackup: 'Last backup', never: 'never', share: 'Share', shareText: 'As text', shareImg: 'As image', shareEmpty: 'The note is empty', copied: 'Copied to clipboard', imgSaved: 'Image saved', shareFail: 'Couldn’t share', newerData: 'This data was saved by a newer version of the app. Editing is disabled to protect it.', light: 'Light', dark: 'Dark', language: 'Language', reset: 'Reset all data', resetAsk: 'Delete all notes, tasks and trash?',
    noNotes: 'No notes yet', noNotesSub: 'Tap “New note” to start', nothing: 'Nothing found', nothingSub: 'Try a different word',
    noTasks: 'No tasks', noTasksSub: 'Tap “Add task” to start', titlePh: 'Title', textPh: 'Start writing…', untitled: 'Untitled',
    noContent: 'No content', today: 'Today', yesterday: 'Yesterday', updated: 'updated', nothingYet: 'nothing yet', taskPh: 'Task title',
    checkPh: 'Add a checklist item…', save: 'Save', cancel: 'Cancel', noteW: ['note', 'notes'], taskW: ['item', 'items'],
    trash: 'Trash', emptyTrash: 'Empty trash', trashNote: 'Deleted items are removed after 30 days', trashEmpty: 'Trash is empty',
    trashEmptySub: 'Deleted notes and tasks appear here', restore: 'Restore', purge: 'Delete forever', emptyAsk: 'Delete everything in the trash forever?',
    noteDeleted: 'Note deleted', taskDeleted: 'Task deleted', undo: 'Undo', restored: 'Restored', kindNote: 'Note', kindTask: 'Task',
    export: 'Export data', import: 'Import data', exported: 'Backup saved', imported: 'Imported', importBad: 'This file is not a valid backup',
    nothingNew: 'Nothing new to import', vibration: 'Vibration', vibWhat: 'What vibrates', vibChecks: 'Checkmarks and tasks', vibDel: 'Delete and undo', vibSave: 'Saving and restoring', done: 'Done', sort_new: 'Newest first', sort_old: 'Oldest first', sort_az: 'Title A–Z',
    storageErr: 'Couldn’t save your changes. Storage may be full or blocked by the browser. Export a backup if you can.' },
  ru: { myNotes: 'Мои заметки', searchPh: 'Поиск заметок…', newNote: 'Новая заметка', tasks: 'Задачи', addTask: 'Добавить задачу', settings: 'Настройки',
    theme: 'Тема', accent: 'Цвет акцента', about: 'О приложении LUMO', animations: 'Анимации', newTask: 'Новая задача', wordW: ['слово', 'слова', 'слов'], minRead: 'мин чтения', aVersion: 'Версия', aSchema: 'Схема данных', aNotes: 'Заметки', aTasks: 'Задачи', aTrash: 'В корзине', aSize: 'Размер данных', aStore: 'Хранилище', aBackup: 'Последняя копия', never: 'ещё не было', share: 'Поделиться', shareText: 'Текстом', shareImg: 'Картинкой', shareEmpty: 'Заметка пустая', copied: 'Скопировано', imgSaved: 'Картинка сохранена', shareFail: 'Не удалось поделиться', newerData: 'Эти данные сохранены более новой версией приложения. Редактирование отключено, чтобы их не повредить.', light: 'Светлая', dark: 'Тёмная', language: 'Язык', reset: 'Удалить все данные', resetAsk: 'Удалить все заметки, задачи и корзину?',
    noNotes: 'Заметок пока нет', noNotesSub: 'Нажмите «Новая заметка»', nothing: 'Ничего не найдено', nothingSub: 'Попробуйте другое слово',
    noTasks: 'Задач нет', noTasksSub: 'Нажмите «Добавить задачу»', titlePh: 'Заголовок', textPh: 'Начните писать…', untitled: 'Без названия',
    noContent: 'Пусто', today: 'Сегодня', yesterday: 'Вчера', updated: 'обновлено', nothingYet: 'пока пусто', taskPh: 'Название задачи',
    checkPh: 'Добавить пункт…', save: 'Сохранить', cancel: 'Отмена', noteW: ['заметка', 'заметки', 'заметок'], taskW: ['задача', 'задачи', 'задач'],
    trash: 'Корзина', emptyTrash: 'Очистить корзину', trashNote: 'Удалённое хранится 30 дней', trashEmpty: 'Корзина пуста',
    trashEmptySub: 'Здесь появятся удалённые заметки и задачи', restore: 'Восстановить', purge: 'Удалить навсегда', emptyAsk: 'Удалить всё из корзины навсегда?',
    noteDeleted: 'Заметка удалена', taskDeleted: 'Задача удалена', undo: 'Отменить', restored: 'Восстановлено', kindNote: 'Заметка', kindTask: 'Задача',
    export: 'Экспорт данных', import: 'Импорт данных', exported: 'Резервная копия сохранена', imported: 'Импортировано', importBad: 'Файл не похож на резервную копию',
    nothingNew: 'Новых данных нет', vibration: 'Вибрация', vibWhat: 'Что вибрирует', vibChecks: 'Галочки и задачи', vibDel: 'Удаление и отмена', vibSave: 'Сохранение и восстановление', done: 'Готово', sort_new: 'Сначала новые', sort_old: 'Сначала старые', sort_az: 'По названию А–Я',
    storageErr: 'Не удалось сохранить изменения. Возможно, нет места или хранилище заблокировано. Сделайте экспорт данных.' }
};

Object.assign(L.en, {
  navHome: 'Home', navLists: 'Checklists', navBoards: 'Boards', navSettings: 'Settings', boardTitle: 'Board',
  toolText: 'Text', toolCheck: 'Checklist', toolImage: 'Image', toolArrow: 'Arrow',
  textHolder: 'Type…', itemHolder: 'Item', addItem: 'Add item',
  emptyBoardT: 'The board is empty', emptyBoardS: 'Tap anywhere and start typing',
  hintArrow1: 'Tap the first block', hintArrow2: 'Now tap the second block',
  deleted: 'Deleted', needTwo: 'You need at least two blocks', arrowExists: 'This arrow already exists', imgFail: 'Couldn’t add the image', aBoard: 'Board blocks',
  tasks: 'Checklists', addTask: 'New checklist', newTask: 'New checklist', noTasks: 'No checklists', noTasksSub: 'Tap “+” to add one', noNotesSub: 'Tap “+” to start',
  taskW: ['checklist', 'checklists'], taskDeleted: 'Checklist deleted', kindTask: 'Checklist', taskPh: 'Checklist title', aTasks: 'Checklists',
  resetAsk: 'Delete all notes, checklists, the board and trash?', trashEmptySub: 'Deleted notes and checklists appear here'
});
Object.assign(L.ru, {
  navHome: 'Главная', navLists: 'Чек-листы', navBoards: 'Доски', navSettings: 'Настройки', boardTitle: 'Доска',
  toolText: 'Текст', toolCheck: 'Чек-лист', toolImage: 'Картинка', toolArrow: 'Стрелка',
  textHolder: 'Пишите…', itemHolder: 'Пункт', addItem: 'Добавить пункт',
  emptyBoardT: 'Доска пуста', emptyBoardS: 'Нажмите в любом месте и сразу пишите',
  hintArrow1: 'Нажмите на первый блок', hintArrow2: 'Теперь нажмите на второй блок',
  deleted: 'Удалено', needTwo: 'Нужно минимум два блока', arrowExists: 'Такая стрелка уже есть', imgFail: 'Не удалось добавить картинку', aBoard: 'Блоков на доске',
  tasks: 'Чек-листы', addTask: 'Новый чек-лист', newTask: 'Новый чек-лист', noTasks: 'Чек-листов нет', noTasksSub: 'Нажмите «+», чтобы добавить', noNotesSub: 'Нажмите «+», чтобы начать',
  taskW: ['чек-лист', 'чек-листа', 'чек-листов'], taskDeleted: 'Чек-лист удалён', kindTask: 'Чек-лист', taskPh: 'Название чек-листа', aTasks: 'Чек-листы',
  resetAsk: 'Удалить все заметки, чек-листы, доску и корзину?', trashEmptySub: 'Здесь появятся удалённые заметки и чек-листы'
});
const t = k => L[settings.lang][k];
function count(n, key) {
  const f = t(key);
  if (settings.lang === 'en') return `${n} ${n === 1 ? f[0] : f[1]}`;
  const a = n % 10, b = n % 100;
  return `${n} ${a === 1 && b !== 11 ? f[0] : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? f[1] : f[2]}`;
}
function fmtDate(ts) {
  const d = new Date(ts), today = new Date().setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(ts).setHours(0, 0, 0, 0)) / DAY);
  if (diff <= 0) return t('today');
  if (diff === 1) return t('yesterday');
  return d.toLocaleDateString(settings.lang, diff < 7 ? { weekday: 'short' } : { day: 'numeric', month: 'short' });
}
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.accent = settings.accent;
  document.documentElement.dataset.anim = settings.anim !== false ? 'on' : 'off';
  $$('#swatches button').forEach(b => b.classList.toggle('on', b.dataset.v === settings.accent));
}
function applyLang() {
  document.documentElement.lang = settings.lang;
  $$('[data-i18n]').forEach(el => el.textContent = t(el.dataset.i18n));
  $$('[data-i18n-ph]').forEach(el => el.placeholder = t(el.dataset.i18nPh));
  $$('#segTheme button').forEach(b => b.classList.toggle('on', b.dataset.v === settings.theme));
  $$('#segLang button').forEach(b => b.classList.toggle('on', b.dataset.v === settings.lang));
  BD.lang();
  renderAll();
}

/* ---------- shared UI helpers ---------- */
const A = p => `<svg class="art" viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ART = {
  notes: A('<rect x="18" y="12" width="50" height="68" rx="11"/><path d="M30 33h26M30 46h26M30 59h14" opacity=".45"/><path d="m58 72 22-22 9 9-22 22-12 3z" fill="currentColor" fill-opacity=".18"/>'),
  tasks: A('<rect x="16" y="14" width="64" height="68" rx="14"/><path d="M32 36l5 5 9-10M32 62l5 5 9-10"/><path d="M54 38h14M54 64h14" opacity=".45"/>'),
  search: A('<circle cx="42" cy="42" r="22" fill="currentColor" fill-opacity=".12"/><path d="m59 59 20 20"/><path d="M32 40a11 11 0 0 1 10-10" opacity=".45"/>'),
  trash: A('<path d="M24 28h48M38 28v-8h20v8M30 28l4 50h28l4-50"/><path d="M42 42v22M54 42v22" opacity=".45"/>')
};
const emptyHTML = (a, b, art) => `<div class="empty">${ART[art] || ''}<b>${a}</b>${b}</div>`;
const buzz = (ms = 10, kind = 'checks') => { if (settings.vibrate && settings.vib?.[kind] !== false && navigator.vibrate) navigator.vibrate(ms); };
function stagger(id) {
  const l = $('.list', $('#' + id)); if (!l) return;
  l.classList.add('stagger'); setTimeout(() => l.classList.remove('stagger'), 800);
}
let toastTimer;
function toast(msg, label, fn, ms = 5000) {
  const el = $('#toast'), b = $('#toastBtn');
  $('#toastMsg').textContent = msg; b.hidden = !label; b.textContent = label || '';
  b.onclick = () => { el.classList.remove('show'); if (fn) fn(); };
  el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function removeAnimated(el, done) {
  el.style.height = el.offsetHeight + 'px'; el.style.overflow = 'hidden'; void el.offsetHeight;
  el.style.transition = 'height .45s var(--ease),opacity .45s,margin .45s';
  el.style.height = '0'; el.style.opacity = '0'; el.style.marginBottom = '-12px';
  setTimeout(done, 460);
}
/* swipe left to reveal a delete button; list clicks are handled by the caller */
function enableSwipe(box, onDelete) {
  let st = null, moved = false;
  box.addEventListener('pointerdown', e => {
    moved = false;
    const sw = e.target.closest('.swipe');
    if (!sw || e.target.closest('input')) return;
    st = { sw, fg: $('.swipe-fg', sw), x: e.clientX, y: e.clientY, cur: 0, lock: false, armed: false, w: sw.offsetWidth };
  });
  box.addEventListener('pointermove', e => {
    if (!st) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (!st.lock) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { st = null; return; }
      if (dx > -8) return; // only a swipe to the left
      st.lock = true; st.fg.style.transition = 'none'; st.sw.classList.add('swiping'); st.sw.setPointerCapture(e.pointerId);
    }
    st.cur = Math.max(-st.w, Math.min(0, dx));
    st.fg.style.transform = `translateX(${st.cur}px)`;
    const armed = st.cur <= -Math.min(st.w * .4, 130);
    if (armed !== st.armed) { st.armed = armed; st.sw.classList.toggle('armed', armed); if (armed) buzz(15, 'del'); }
  });
  const end = () => {
    if (!st) return;
    const s = st; st = null;
    if (!s.lock) return;
    moved = true; s.fg.style.transition = '';
    if (s.armed) { // far enough: the card flies out and is deleted
      s.fg.style.transform = 'translateX(-110%)';
      setTimeout(() => onDelete(s.sw), 320);
    } else {
      s.fg.style.transform = ''; s.sw.classList.remove('armed');
      setTimeout(() => s.sw.classList.remove('swiping'), 450);
    }
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('click', e => { if (moved) { moved = false; e.stopPropagation(); } }, true);
}
const delBtn = `<button class="swipe-del" aria-label="Delete">${icon('bin')}</button>`;

/* ---------- trash + undo ---------- */
function toTrash(kind, item) {
  const x = { tid: uid(), kind, item, deletedAt: Date.now() };
  trash.unshift(x); return x.tid;
}
function undoDelete(tid, kind) {
  buzz(20, 'del');
  toast(t(kind === 'note' ? 'noteDeleted' : 'taskDeleted'), t('undo'), () => { restore(tid); buzz(10, 'save'); });
}
function restore(tid) {
  const i = trash.findIndex(x => x.tid === tid); if (i < 0) return;
  const [x] = trash.splice(i, 1);
  if (x.kind === 'note') { notes.push(x.item); fresh = x.item.id; } else { tasks.push(x.item); freshTask = x.item.id; }
  save('notes', 'tasks', 'trash'); renderAll();
}
function renderTrash() {
  $('#trashCount').textContent = trash.length || '';
  $('#trashList').innerHTML = trash.length ? trash.map(x => `
    <div class="card titem" data-tid="${x.tid}">
      <div class="row1"><span class="t">${esc(x.kind === 'note' ? (titleOf(x.item) || t('untitled')) : x.item.text)}</span>
        <span class="d">${t(x.kind === 'note' ? 'kindNote' : 'kindTask')} · ${fmtDate(x.deletedAt)}</span></div>
      <div class="tact"><button data-act="restore">${t('restore')}</button><button data-act="purge" class="danger">${t('purge')}</button></div>
    </div>`).join('') : emptyHTML(t('trashEmpty'), t('trashEmptySub'), 'trash');
  $('#emptyTrash').hidden = !trash.length;
}
$('#trashList').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const tid = b.closest('.titem').dataset.tid;
  if (b.dataset.act === 'restore') { restore(tid); toast(t('restored')); buzz(10, 'save'); }
  else { trash = trash.filter(x => x.tid !== tid); save('trash'); renderTrash(); }
});
$('#emptyTrash').addEventListener('click', () => {
  if (!confirm(t('emptyAsk'))) return;
  trash = []; save('trash'); renderTrash();
});

/* ---------- navigation ---------- */
function show(name) {
  const tab = name === 'trash' ? 'settings' : name;
  $$('.screen:not(.editor)').forEach(s => s.classList.toggle('active', s.id === name));
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const idx = TABS.indexOf(tab); if (idx !== tabIdx) { tabIdx = idx; movePill(idx); }
  renderAll(); stagger(name); BD.shown(name);
}
$('#nav').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || !b.dataset.tab) return;
  if (location.hash && location.hash !== '#/') history.replaceState({ lumo: 1 }, '', '#/');
  show(b.dataset.tab);
});
$('#openTrash').addEventListener('click', () => pushHash('#/trash'));
$('#trashBack').addEventListener('click', goBack);

/* ---------- notes list + sorting ---------- */
let fresh = null;
const SORTS = ['new', 'old', 'az'];
const sorters = {
  new: (a, b) => b.updated - a.updated,
  old: (a, b) => a.updated - b.updated,
  az: (a, b) => (titleOf(a) || '\uffff').localeCompare(titleOf(b) || '\uffff', settings.lang, { sensitivity: 'base' })
};
const sorted = () => [...notes].sort(sorters[settings.sort] || sorters.new);
const firstLine = n => n.text.split('\n').map(s => s.trim()).find(Boolean) || '';
const titleOf = n => n.title.trim() || firstLine(n).slice(0, 80);               // no title -> first line of the text
const bodyOf = n => { // the text without the line that is already used as the title
  if (n.title.trim()) return n.text;
  const lines = n.text.split('\n'), i = lines.findIndex(l => l.trim());
  return i < 0 ? '' : lines.slice(i + 1).join('\n');
};
const snippet = n => bodyOf(n).split('\n').map(s => s.trim()).find(Boolean) || (titleOf(n) ? '' : t('noContent'));
const hl = (s, q) => { // escape + wrap every match in <mark>
  if (!q) return esc(s);
  const lo = s.toLowerCase(); let out = '', i = 0, j;
  while ((j = lo.indexOf(q, i)) > -1) { out += esc(s.slice(i, j)) + '<mark>' + esc(s.slice(j, j + q.length)) + '</mark>'; i = j + q.length; }
  return out + esc(s.slice(i));
};
function snippetFor(n, q) { // if the match is deeper in the text, show the part around it
  const first = snippet(n);
  if (!q || first.toLowerCase().includes(q)) return first;
  const body = bodyOf(n), i = body.toLowerCase().indexOf(q); if (i < 0) return first;
  const from = Math.max(0, i - 20);
  return (from > 0 ? '…' : '') + body.slice(from, from + 100).replace(/\s+/g, ' ').trim();
}
const noteHTML = (n, q = '') => `
  <div class="swipe${n.id === fresh ? ' pop' : ''}" data-id="${n.id}">${delBtn}
    <div class="swipe-fg card">
      <div class="row1"><span class="t">${titleOf(n) ? hl(titleOf(n), q) : esc(t('untitled'))}</span><span class="d">${fmtDate(n.updated)}</span></div>
      ${snippetFor(n, q) ? `<p class="s">${hl(snippetFor(n, q), q)}</p>` : ''}
    </div>
  </div>`;
function renderNotes() {
  const q = $('#homeSearch').value.trim().toLowerCase();
  const list = sorted().filter(n => !q || n.title.toLowerCase().includes(q) || n.text.toLowerCase().includes(q));
  $('#notesMeta').textContent = notes.length
    ? `${count(notes.length, 'noteW')} • ${t('updated')} ${fmtDate(Math.max(...notes.map(n => n.updated))).toLowerCase()}`
    : `${count(0, 'noteW')} • ${t('nothingYet')}`;
  $('#notesList').innerHTML = list.length ? list.map(n => noteHTML(n, q)).join('')
    : q ? emptyHTML(t('nothing'), t('nothingSub'), 'search') : emptyHTML(t('noNotes'), t('noNotesSub'), 'notes');
  $('#sortMenu').innerHTML = SORTS.map(v => `<button data-v="${v}" class="${settings.sort === v ? 'on' : ''}">${t('sort_' + v)}${settings.sort === v ? icon('check') : ''}</button>`).join('');
  fresh = null; riseUp($('#notesList'));
}
$('#homeSearch').addEventListener('input', renderNotes);
$('#newNote').addEventListener('click', () => openNoteUI(null, $('#newNote')));
$('#sortBtn').addEventListener('click', e => { e.stopPropagation(); $('#moreMenu').classList.remove('show'); $('#sortMenu').classList.toggle('show'); });
$('#sortMenu').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  settings.sort = b.dataset.v; saveSettings(); $('#sortMenu').classList.remove('show'); renderNotes();
});
document.addEventListener('click', e => {
  if (!e.target.closest('#sortMenu')) $('#sortMenu').classList.remove('show');
  if (!e.target.closest('#moreMenu')) $('#moreMenu').classList.remove('show');
});
function deleteNoteEl(sw) {
  removeAnimated(sw, () => {
    const n = notes.find(x => x.id === sw.dataset.id); if (!n) return renderAll();
    notes = notes.filter(x => x !== n);
    const tid = toTrash('note', n); save('notes', 'trash'); renderAll(); undoDelete(tid, 'note');
  });
}
enableSwipe($('#notesList'), deleteNoteEl);
$('#notesList').addEventListener('click', e => {
  const sw = e.target.closest('.swipe'); if (sw) openNoteUI(sw.dataset.id, sw);
});

/* ---------- note editor (title + text only) ---------- */
let cur = null, timer;
const eTitle = $('#eTitle'), eText = $('#eText');
const setBar = () => { $('#barTitle').textContent = titleOf(cur) || t('newNote'); };
const wordsIn = s => (s.trim().match(/\S+/g) || []).length;
function updateStat() { // words + reading time under the editor
  const w = cur ? wordsIn(cur.title + ' ' + cur.text) : 0;
  $('#estat').textContent = w ? `${count(w, 'wordW')} · ${Math.max(1, Math.ceil(w / 200))} ${t('minRead')}` : count(0, 'wordW');
}
function openNote(id, from) {
  const n = notes.find(x => x.id === id);
  if (!n && !(history.state && history.state.fresh === id)) return false;
  cur = n || { id, title: '', text: '', updated: Date.now() };
  eTitle.value = cur.title; eText.value = cur.text; setBar(); updateStat();
  $('#app').classList.add('in-editor');
  openOverlay($('#editor'), from, () => { if (!n) eTitle.focus(); });
  return true;
}
function commit() {
  clearTimeout(timer);
  if (!cur) return;
  cur.updated = Date.now();
  if (!notes.includes(cur)) {
    if (!cur.title.trim() && !cur.text.trim()) return;
    notes.push(cur); fresh = cur.id;
  }
  save('notes');
}
const touch = () => { clearTimeout(timer); timer = setTimeout(commit, 250); };
function closeEditor() {
  const ed = $('#editor');
  if (ed._closing) return;
  commit();
  const id = cur && cur.id, wasFresh = id && id === fresh;
  cur = null;
  if (document.activeElement) document.activeElement.blur();
  $('#app').classList.remove('in-editor');
  riseDelay = wasFresh ? 380 : 0; // a brand-new card rises while the editor is leaving
  renderAll(); riseDelay = 0;
  closeOverlay(ed, id && !wasFresh ? $(`#notesList .swipe[data-id="${id}"]`) : null);
}
eTitle.addEventListener('input', () => { cur.title = eTitle.value; setBar(); updateStat(); touch(); });
eTitle.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); eText.focus(); } });
eText.addEventListener('input', () => { cur.text = eText.value; setBar(); updateStat(); touch(); });
$('#back').addEventListener('click', goBack);
$('#menuBtn').addEventListener('click', () => {
  clearTimeout(timer);
  const n = cur;
  if (notes.includes(n)) {
    notes = notes.filter(x => x !== n);
    const tid = toTrash('note', n); save('notes', 'trash');
    cur = null; goBack(); undoDelete(tid, 'note');
  } else { cur = null; goBack(); }
});
window.addEventListener('pagehide', commit);
document.addEventListener('visibilitychange', () => { if (document.hidden) commit(); });

/* ---------- tasks (title + checklist) ---------- */
const expanded = new Set();
let freshTask = null;
const checkHTML = c => `
  <li class="${c.done ? 'done' : ''}" data-cid="${c.id}">
    <button class="cb" data-act="cb">${icon('check')}</button><span class="ct">${esc(c.text)}</span>
    <button class="cx" data-act="cx" aria-label="Delete">${icon('x')}</button>
  </li>`;
const progress = k => `${k.checks.filter(c => c.done).length}/${k.checks.length}`;
const pct = k => k.checks.length ? Math.round(k.checks.filter(c => c.done).length / k.checks.length * 100) : 0;
const taskHTML = k => `
  <div class="swipe${k.id === freshTask ? ' pop' : ''}" data-id="${k.id}">${delBtn}
    <div class="swipe-fg task${k.done ? ' done' : ''}${expanded.has(k.id) ? ' expanded' : ''}">
      <div class="thead">
        <button class="circle" data-act="done" aria-label="Done">${icon('check')}</button>
        <span class="tt" data-act="expand">${esc(k.text)}</span>
        ${k.checks.length ? `<span class="prog">${progress(k)}</span>` : ''}
        <button class="chev" data-act="expand" aria-label="Expand">${icon('chev-d')}</button>
      </div>
      ${k.checks.length ? `<div class="bar"><i style="width:${pct(k)}%"></i></div>` : ''}
      <div class="cwrap${k.checks.length > 2 ? ' more' : ''}">
        <ul class="clist">${k.checks.map(checkHTML).join('')}</ul>
        <input class="cadd" placeholder="${esc(t('checkPh'))}" autocomplete="off">
      </div>
    </div>
  </div>`;
function renderTasks() {
  $('#tasksMeta').textContent = `${t('today')} · ${count(tasks.length, 'taskW')}`;
  $('#tasksList').innerHTML = tasks.length ? tasks.map(taskHTML).join('') : emptyHTML(t('noTasks'), t('noTasksSub'), 'tasks');
  freshTask = null; riseUp($('#tasksList'));
}
function deleteTaskEl(sw) {
  removeAnimated(sw, () => {
    const k = tasks.find(x => x.id === sw.dataset.id); if (!k) return renderAll();
    tasks = tasks.filter(x => x !== k); expanded.delete(k.id);
    const tid = toTrash('task', k); save('tasks', 'trash'); renderAll(); undoDelete(tid, 'task');
  });
}
enableSwipe($('#tasksList'), deleteTaskEl);
$('#tasksList').addEventListener('click', e => {
  const sw = e.target.closest('.swipe'); if (!sw) return;
  const k = tasks.find(x => x.id === sw.dataset.id), fg = $('.swipe-fg', sw);
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'done') { k.done = !k.done; fg.classList.toggle('done', k.done); buzz(); if (k.done) { b.classList.remove('burst'); void b.offsetWidth; b.classList.add('burst'); } }
  else if (a === 'expand') { fg.classList.toggle('expanded') ? expanded.add(k.id) : expanded.delete(k.id); }
  else {
    const li = b.closest('li'), c = k.checks.find(x => x.id === li.dataset.cid);
    if (a === 'cb') { c.done = !c.done; li.classList.toggle('done', c.done); $('.prog', sw).textContent = progress(k); $('.bar i', sw).style.width = pct(k) + '%'; buzz(); }
    if (a === 'cx') { k.checks = k.checks.filter(x => x !== c); save('tasks'); return renderTasks(); }
  }
  save('tasks');
});
$('#tasksList').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.classList.contains('cadd') || !e.target.value.trim()) return;
  const sw = e.target.closest('.swipe'), k = tasks.find(x => x.id === sw.dataset.id);
  k.checks.push({ id: uid(), text: e.target.value.trim(), done: false }); save('tasks'); renderTasks();
  $(`.swipe[data-id="${k.id}"] .cadd`).focus();
});

/* add-task sheet: title first, then checklist items */
let draft = [];
const taskEd = $('#taskEditor');
let taskSaved = false;
const drawDraft = () => {
  $('#sChecks').innerHTML = draft.map((c, i) => `<li data-i="${i}"><span class="cb"></span><span class="ct">${esc(c)}</span><button class="cx" aria-label="Delete">${icon('x')}</button></li>`).join('');
};
function pushDraft() { const v = $('#sAdd').value.trim(); if (v) { draft.push(v); drawDraft(); } $('#sAdd').value = ''; }
$('#addTask').addEventListener('click', () => { originEl = $('#addTask'); pushHash('#/task'); });
$('#sTitle').addEventListener('keydown', e => { if (e.key === 'Enter') $('#sAdd').focus(); });
$('#sAdd').addEventListener('keydown', e => { if (e.key === 'Enter') pushDraft(); });
$('#sChecks').addEventListener('click', e => {
  const li = e.target.closest('li'); if (li && e.target.closest('.cx')) { draft.splice(+li.dataset.i, 1); drawDraft(); }
});
$('#tBack').addEventListener('click', goBack);
$('#sSave').addEventListener('click', () => {
  pushDraft();
  const title = $('#sTitle').value.trim();
  if (!title) { const el = $('#sTitle'); el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); el.focus(); return; }
  const k = { id: uid(), text: title, done: false, checks: draft.map(text => ({ id: uid(), text, done: false })) };
  riseDelay = 380; tasks.push(k); freshTask = k.id; save('tasks'); renderTasks(); riseDelay = 0;
  taskSaved = true; goBack(); buzz(15, 'save');
  const list = $('#tasksList'); list.scrollTop = list.scrollHeight;
});

/* ---------- settings, export / import ---------- */
$('#segTheme').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.dataset.v === settings.theme) return;
  const apply = () => { settings.theme = b.dataset.v; saveSettings(); applyTheme(); applyLang(); };
  const root = document.documentElement; root.classList.add('theme-switch'); // nothing may fade on its own: the page cross-fades as one picture
  if (document.startViewTransition && animOn()) document.startViewTransition(apply).finished.finally(() => root.classList.remove('theme-switch'));
  else { apply(); setTimeout(() => root.classList.remove('theme-switch'), 80); }
});
$('#segLang').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; settings.lang = b.dataset.v; saveSettings(); applyLang(); });
$('#swatches').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; settings.accent = b.dataset.v; saveSettings(); applyTheme(); });
$('#setAnim').checked = settings.anim !== false;
$('#setAnim').addEventListener('change', e => { settings.anim = e.target.checked; saveSettings(); applyTheme(); });
$('#setVib').checked = settings.vibrate;
$('#setVib').addEventListener('change', e => { settings.vibrate = e.target.checked; saveSettings(); buzz(); });
$('#resetData').addEventListener('click', () => {
  if (!confirm(t('resetAsk'))) return;
  notes = []; tasks = []; trash = []; expanded.clear(); BD.reset(); save('notes', 'tasks', 'trash', 'board'); renderAll();
});
$('#exportBtn').addEventListener('click', async () => {
  let images = {};
  try { images = await BD.collectImages(); } catch (e) { console.error(e); }
  const data = { app: 'lumo', version: 4, schema: SCHEMA, exportedAt: new Date().toISOString(), notes, tasks, board, images };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `lumo-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  settings.lastBackup = new Date().toISOString(); saveSettings(); toast(t('exported'));
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());
const cleanNote = n => ({ id: String(n.id || uid()), title: String(n.title || ''), text: String(n.text || ''), updated: Number(n.updated) || Date.now() });
const cleanTask = k => ({
  id: String(k.id || uid()), text: String(k.text || ''), done: !!k.done,
  checks: (Array.isArray(k.checks) ? k.checks : []).filter(c => c && typeof c === 'object').map(c => ({ id: String(c.id || uid()), text: String(c.text || ''), done: !!c.done }))
});
$('#importFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d || !['nexus', 'lumo'].includes(d.app) || (!Array.isArray(d.notes) && !Array.isArray(d.tasks) && !d.board)) throw new Error('bad file');
    const have = new Set([...notes, ...tasks].map(x => x.id)); let nn = 0, kk = 0;
    const take = (list, clean, target, onAdd) => (Array.isArray(list) ? list : []).forEach(raw => {
      if (!raw || typeof raw !== 'object') return;
      const x = clean(raw); if (have.has(x.id)) return;
      have.add(x.id); target.push(x); onAdd();
    });
    take(d.notes, cleanNote, notes, () => nn++);
    take(d.tasks, cleanTask, tasks, () => kk++);
    const bb = d.board && typeof d.board === 'object' ? await BD.merge(d.board, d.images) : 0;
    if (nn + kk + bb) { save('notes', 'tasks'); renderAll(); toast(`${t('imported')}: ${count(nn, 'noteW')}, ${count(kk, 'taskW')}${bb ? ', ' + bb : ''}`); }
    else toast(t('nothingNew'));
  } catch { toast(t('importBad')); }
});

/* main-screen "..." menu (export / import) */
$('#moreBtn').addEventListener('click', e => { e.stopPropagation(); $('#sortMenu').classList.remove('show'); $('#moreMenu').classList.toggle('show'); });

/* vibration details sheet: tap the row (not the switch) */
const vibSheet = $('#vibSheet');
$('#vibRow').addEventListener('click', e => { if (!e.target.closest('.switch')) openSheet(vibSheet); });
$$('[data-vib]').forEach(i => {
  i.checked = settings.vib?.[i.dataset.vib] !== false;
  i.addEventListener('change', () => { settings.vib = { ...settings.vib, [i.dataset.vib]: i.checked }; saveSettings(); buzz(10, i.dataset.vib); });
});
$('#vibDone').addEventListener('click', closeSheet);

/* ---------- routing: system Back closes editor / trash / sheets ---------- */
let originEl = null, closing = false;
const EASE = 'cubic-bezier(.45,.05,.2,1)';
const animOn = () => settings.anim !== false; // our own switch; the phone's "remove animations" no longer silences everything
function pushHash(hash) { history.pushState({ lumo: 1 }, '', hash); route(); }
function goBack() {
  if (history.state && history.state.lumo) history.back();
  else { history.replaceState(null, '', '#/'); route(); }
}
function openNoteUI(id, el) {
  originEl = el;
  if (id) return pushHash('#/note/' + id);
  const nid = uid(); history.pushState({ lumo: 1, fresh: nid }, '', '#/note/' + nid); route();
}
function openSheet(el) {
  el.classList.add('show');
  if (location.hash !== '#/sheet') history.pushState({ lumo: 1 }, '', '#/sheet');
}
function closeSheet() {
  if (location.hash === '#/sheet') history.back();
  else $$('.sheet.show').forEach(s => s.classList.remove('show'));
}
function route() {
  const h = location.hash, m = h.match(/^#\/note\/(.+)$/), ed = $('#editor'), te = $('#taskEditor');
  if (m) { if (!ed.classList.contains('active') && ready && !openNote(m[1], originEl)) history.replaceState(null, '', '#/'); }
  else if (ed.classList.contains('active') && !ed._closing) closeEditor();
  if (h === '#/task') { if (!te.classList.contains('active') && ready) openTaskEditor(originEl); }
  else if (te.classList.contains('active') && !te._closing) closeTaskEditor();
  originEl = null;
  const trashOn = $('#trash').classList.contains('active');
  if (h === '#/trash') { if (!trashOn) show('trash'); }
  else if (trashOn) show('settings');
  if (h !== '#/sheet') $$('.sheet.show').forEach(s => s.classList.remove('show'));
}
window.addEventListener('popstate', route);
$$('.sheet [data-close]').forEach(el => el.addEventListener('click', closeSheet));

/* ---------- collapsing "My notes" title on scroll ---------- */
function layoutHeaders() { // the list scrolls under the floating glass bar, so it needs the bar's height as top padding
  $$('.screen:not(.editor).active').forEach(s => {
    const hd = $('.hd', s), list = $('.list', s); if (!hd || !list) return;
    list.style.paddingTop = (hd.offsetTop + hd.offsetHeight + 12) + 'px';
  });
}

/* ---------- about ---------- */
const fmtSize = b => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
function renderAbout() {
  const size = new Blob([JSON.stringify({ notes, tasks, trash })]).size;
  const bk = settings.lastBackup
    ? new Date(settings.lastBackup).toLocaleString(settings.lang, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : t('never');
  const rows = [['aVersion', `LUMO ${APP_VERSION}`], ['aSchema', `v${SCHEMA}`], ['aNotes', notes.length], ['aTasks', tasks.length],
    ['aBoard', board.items.length], ['aTrash', trash.length], ['aSize', fmtSize(size)], ['aStore', store.mode === 'idb' ? 'IndexedDB' : 'localStorage'], ['aBackup', bk]];
  $('#aboutList').innerHTML = rows.map(([k, v]) => `<div class="ab"><span>${t(k)}</span><b>${esc(v)}</b></div>`).join('');
}
$('#aboutRow').addEventListener('click', () => { renderAbout(); openSheet($('#aboutSheet')); });

/* ---------- share: text or picture card ---------- */
const SW = 1080, SH = 1350, FONT = '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif';
function rr(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function wrapText(c, text, maxW, maxLines) {
  const lines = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { lines.push(''); continue; }
    let line = '';
    for (let w of para.split(/\s+/)) {
      while (c.measureText(w).width > maxW) { // very long word: break it
        let i = 1; while (i < w.length && c.measureText(w.slice(0, i + 1)).width <= maxW) i++;
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, i)); w = w.slice(i);
      }
      const test = line ? line + ' ' + w : w;
      if (c.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
    }
    lines.push(line);
  }
  if (lines.length > maxLines) { lines.length = maxLines; const l = lines[maxLines - 1]; lines[maxLines - 1] = (l.length > 2 ? l.slice(0, -2) : l) + '…'; }
  return lines;
}
function drawShareCard(n) {
  const cv = $('#shareCanvas'), c = cv.getContext('2d'); cv.width = SW; cv.height = SH;
  const css = getComputedStyle(document.documentElement), v = k => css.getPropertyValue(k).trim();
  const a1 = v('--accent'), a2 = v('--accent-2') || a1, card = v('--card'), ink = v('--ink'), muted = v('--muted');
  const g = c.createLinearGradient(0, 0, SW, SH); g.addColorStop(0, a1); g.addColorStop(1, a2);
  c.fillStyle = g; c.fillRect(0, 0, SW, SH);
  c.fillStyle = 'rgba(255,255,255,.14)';
  c.beginPath(); c.arc(960, 120, 260, 0, 7); c.fill(); c.beginPath(); c.arc(80, 1260, 220, 0, 7); c.fill();
  c.save(); c.shadowColor = 'rgba(0,0,0,.25)'; c.shadowBlur = 60; c.shadowOffsetY = 24;
  c.fillStyle = card; rr(c, 80, 130, 920, 1090, 60); c.fill(); c.restore();
  const X = 140, W = 800; let y = 270;
  c.font = `500 70px ${FONT}`; c.fillStyle = ink;
  wrapText(c, titleOf(n) || t('untitled'), W, 2).forEach(l => { c.fillText(l, X, y); y += 88; });
  const bar = c.createLinearGradient(X, 0, X + 160, 0); bar.addColorStop(0, a1); bar.addColorStop(1, a2);
  c.fillStyle = bar; rr(c, X, y - 44, 160, 10, 5); c.fill(); y += 30;
  c.font = `400 42px ${FONT}`; c.fillStyle = ink; c.globalAlpha = .85;
  wrapText(c, bodyOf(n).trim(), W, Math.max(1, Math.floor((1120 - y) / 64))).forEach(l => { c.fillText(l, X, y); y += 64; });
  c.globalAlpha = 1;
  c.font = `500 40px ${FONT}`; c.fillStyle = a1; c.fillText('LUMO', X, 1175);
  c.font = `400 32px ${FONT}`; c.fillStyle = muted; c.textAlign = 'right';
  c.fillText(new Date(n.updated).toLocaleDateString(settings.lang, { day: 'numeric', month: 'long', year: 'numeric' }), X + W, 1175); c.textAlign = 'left';
}
async function openShare() {
  const n = cur;
  if (!n || (!n.title.trim() && !n.text.trim())) return toast(t('shareEmpty'));
  try { await Promise.all([document.fonts.load('500 40px Inter', n.title + 'LUMO'), document.fonts.load('400 40px Inter', n.text.slice(0, 600))]); } catch {}
  drawShareCard(n); openSheet($('#shareSheet'));
}
$('#shareBtn').addEventListener('click', openShare);
const copyText = async text => { try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { toast(t('shareFail')); } };
$('#shareText').addEventListener('click', async () => {
  const n = cur, text = [titleOf(n), bodyOf(n).trim()].filter(Boolean).join('\n\n');
  closeSheet();
  if (!navigator.share) return copyText(text);
  try { await navigator.share({ title: titleOf(n) || 'LUMO', text }); } catch (e) { if (e.name !== 'AbortError') copyText(text); }
});
$('#shareImg').addEventListener('click', () => {
  const name = (titleOf(cur) || 'note').replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 30);
  $('#shareCanvas').toBlob(async blob => {
    const file = new File([blob], `lumo-${name}.png`, { type: 'image/png' });
    closeSheet();
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
      else {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name;
        document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast(t('imgSaved'));
      }
    } catch (e) { if (e.name !== 'AbortError') toast(t('shareFail')); }
  }, 'image/png');
});

/* ---------- motion helpers (all slowed down so they are actually visible) ---------- */
let riseDelay = 0;
const cssVar = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
const insetFor = (er, r, rad) => `inset(${r.top - er.top}px ${er.right - r.right}px ${er.bottom - r.bottom}px ${r.left - er.left}px round ${rad}px)`;
function openOverlay(ed, from, onDone) { // the card / button grows into a full-screen page
  ed.classList.add('active');
  if (!from || !animOn() || !ed.animate) { if (onDone) onDone(); return; }
  const er = ed.getBoundingClientRect(), r = from.getBoundingClientRect(), fg = $('.swipe-fg', from);
  const bg = getComputedStyle(ed).backgroundColor;
  const a = ed.animate([
    { clipPath: insetFor(er, r, fg ? 24 : 30), backgroundColor: fg ? getComputedStyle(fg).backgroundColor : cssVar('--accent'), offset: 0 },
    { backgroundColor: bg, offset: .5 }, // blue only for the first half, from the middle on it is already the page colour
    { clipPath: 'inset(0px round 0px)', backgroundColor: bg, offset: 1 }
  ], { duration: 650, easing: EASE });
  $$('.ebar, .ebody, .estat, .tsave', ed).forEach(el => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, delay: 250, easing: 'ease-out', fill: 'backwards' }));
  a.onfinish = () => { if (onDone) onDone(); };
}
function closeOverlay(ed, toEl, onDone) { // shrink back into the card / button, or slide down
  const finish = () => { ed.classList.remove('active'); ed.style.height = ''; ed.getAnimations({ subtree: true }).forEach(x => x.cancel()); ed._closing = false; if (onDone) onDone(); };
  if (!ed.animate || !animOn()) return finish();
  ed._closing = true;
  ed.style.height = '100%'; // ignore the on-screen keyboard while leaving, so the target does not move under the animation
  let to = null, toBg = null;
  if (toEl) {
    const er = ed.getBoundingClientRect(), r = toEl.getBoundingClientRect(), fg = $('.swipe-fg', toEl);
    if (r.bottom > 0 && r.top < innerHeight) { to = insetFor(er, r, fg ? 24 : 30); toBg = fg ? getComputedStyle(fg).backgroundColor : cssVar('--accent'); }
  }
  const bg = getComputedStyle(ed).backgroundColor;
  const a = to
    ? ed.animate([
        { clipPath: 'inset(0px round 0px)', backgroundColor: bg, offset: 0 },
        { backgroundColor: bg, offset: .5 }, // stays the page colour for the first half, turns into the card / button colour after it
        { clipPath: to, backgroundColor: toBg, offset: 1 }
      ], { duration: 520, easing: EASE, fill: 'forwards' })
    : ed.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(60px)' }], { duration: 480, easing: EASE, fill: 'forwards' });
  if (to) $$('.ebar, .ebody, .estat, .tsave', ed).forEach(el => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: 'forwards' }));
  a.onfinish = finish;
}
function riseIn(el) { // new card: height grows, so the others glide apart, while it floats up from below
  if (!animOn() || !el.animate) return;
  const h = el.offsetHeight; if (!h) return;
  el.style.overflow = 'hidden';
  const a = el.animate([
    { height: '0px', marginBottom: '-12px', opacity: 0, transform: 'translateY(56px)' },
    { height: h + 'px', marginBottom: '0px', opacity: 1, transform: 'none' }
  ], { duration: 900, delay: riseDelay, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' });
  a.onfinish = () => { el.style.overflow = ''; };
}
const riseUp = list => $$('.swipe.pop', list).forEach(riseIn);

/* toasts and the storage banner can be flicked away to the left or right */
function swipeDismiss(el, done) {
  let x0 = null, dx = 0, lock = false;
  el.style.touchAction = 'pan-y';
  el.addEventListener('pointerdown', e => { x0 = e.clientX; dx = 0; lock = false; });
  el.addEventListener('pointermove', e => {
    if (x0 === null) return;
    dx = e.clientX - x0;
    if (!lock && Math.abs(dx) > 8) { lock = true; el.style.transition = 'none'; el.setPointerCapture(e.pointerId); }
    if (lock) { el.style.transform = `translateX(${dx}px)`; el.style.opacity = 1 - Math.min(Math.abs(dx) / 260, .85); }
  });
  const end = () => {
    if (x0 === null) return; x0 = null; el.style.transition = '';
    if (lock && Math.abs(dx) > 70) {
      el.style.transform = `translateX(${dx > 0 ? 130 : -130}%)`; el.style.opacity = '0';
      setTimeout(() => { done(); el.style.transform = ''; el.style.opacity = ''; }, 380);
    } else { el.style.transform = ''; el.style.opacity = ''; }
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
swipeDismiss($('#toast'), () => { clearTimeout(toastTimer); $('#toast').classList.remove('show'); });
swipeDismiss($('#banner'), () => { $('#banner').hidden = true; });

/* full-screen "new task" page */
function openTaskEditor(from) {
  draft = []; $('#sTitle').value = ''; $('#sAdd').value = ''; drawDraft();
  openOverlay(taskEd, from, () => $('#sTitle').focus());
}
function closeTaskEditor() {
  if (taskEd._closing) return;
  if (document.activeElement) document.activeElement.blur();
  const to = taskSaved ? null : $('#plusBtn'); taskSaved = false;
  closeOverlay(taskEd, to);
}

/* keep the pages above the on-screen keyboard */
if (window.visualViewport) {
  const f = () => document.documentElement.style.setProperty('--vvh', Math.round(visualViewport.height) + 'px');
  visualViewport.addEventListener('resize', f); f();
}

/* ---------- bottom nav: one liquid pill + swipe between the tabs ---------- */
const TABS = ['notes', 'tasks', 'boards', 'settings'];
let tabIdx = 0;
const navEl = $('#nav'), pill = $('#pill');
function tabBox(i) {
  const nr = navEl.getBoundingClientRect(), r = $$('#nav button[data-tab]')[i].getBoundingClientRect();
  return { left: r.left - nr.left - navEl.clientLeft, width: r.width, top: r.top - nr.top - navEl.clientTop, height: r.height };
}
const putPill = b => Object.assign(pill.style, { left: b.left + 'px', width: b.width + 'px', top: b.top + 'px', height: b.height + 'px' });
const placePill = () => putPill(tabBox(tabIdx));
function movePill(to) { // the front edge runs ahead, the back edge catches up: the pill stretches like a drop
  const nr = navEl.getBoundingClientRect(), pr = pill.getBoundingClientRect(), b = tabBox(to);
  const from = { left: pr.left - nr.left - navEl.clientLeft, width: pr.width };
  pill.getAnimations().forEach(a => a.cancel());
  putPill(b);
  if (!animOn() || !pill.animate || !from.width) return;
  const mid = b.left > from.left ? { left: from.left, width: b.left + b.width - from.left } : { left: b.left, width: from.left + from.width - b.left };
  pill.animate([
    { left: from.left + 'px', width: from.width + 'px' },
    { left: mid.left + 'px', width: mid.width + 'px', offset: .45 },
    { left: b.left + 'px', width: b.width + 'px' }
  ], { duration: 560, easing: EASE });
}
(function tabSwipe() { // drag the page left / right: the pill follows the finger
  const app = $('#app'); let g = null, swiped = false;
  const blocked = () => $('#boards').classList.contains('active') || $('#editor').classList.contains('active') || $('#taskEditor').classList.contains('active') || $('.sheet.show') || $('#trash').classList.contains('active');
  app.addEventListener('pointerdown', e => {
    swiped = false;
    if (blocked() || e.target.closest('input, textarea, .menu, #toast, #banner')) return;
    g = { x: e.clientX, y: e.clientY, t: performance.now(), from: tabIdx, card: !!e.target.closest('.swipe'), el: $('.screen.active:not(.editor)'), lock: false, m: 0, prog: 0 };
  });
  app.addEventListener('pointermove', e => {
    if (!g) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.lock) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g = null; return; }
      if (Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      const dir = dx < 0 ? 1 : -1, to = g.from + dir;
      if (to < 0 || to >= TABS.length || (dir === 1 && g.card)) { g = null; return; } // a swipe to the left on a card deletes the card
      Object.assign(g, { lock: true, dir, b0: tabBox(g.from), b1: tabBox(to) });
      pill.getAnimations().forEach(a => a.cancel()); g.el.style.transition = 'none'; app.setPointerCapture(e.pointerId);
    }
    const m = Math.max(0, g.dir === 1 ? -dx : dx), prog = Math.min(1, m / (app.clientWidth * .5));
    Object.assign(g, { m, prog });
    g.el.style.transform = `translateX(${-g.dir * m * .4}px)`; g.el.style.opacity = String(1 - prog * .65);
    const extra = Math.abs(g.b1.left - g.b0.left) * Math.sin(prog * Math.PI) * .5;
    putPill({ ...g.b0, left: g.b0.left + (g.b1.left - g.b0.left) * prog - extra / 2, width: g.b0.width + extra });
  });
  const end = () => {
    if (!g) return;
    const s = g; g = null;
    if (!s.lock) return;
    swiped = true;
    const go = s.prog > .35 || (s.m / Math.max(1, performance.now() - s.t) > .5 && s.prog > .08);
    if (go) { s.el.style.transition = ''; s.el.style.transform = ''; s.el.style.opacity = ''; show(TABS[s.from + s.dir]); }
    else { // not far enough: the page and the pill slide back
      s.el.style.transition = 'transform .4s var(--ease), opacity .4s'; s.el.style.transform = ''; s.el.style.opacity = '';
      setTimeout(() => { s.el.style.transition = ''; }, 450); movePill(tabIdx);
    }
  };
  app.addEventListener('pointerup', end);
  app.addEventListener('pointercancel', end);
  app.addEventListener('click', e => { if (swiped) { swiped = false; e.stopPropagation(); e.preventDefault(); } }, true);
})();
requestAnimationFrame(placePill);
window.addEventListener('resize', () => { placePill(); layoutHeaders(); });
if (document.fonts) document.fonts.ready.then(() => { placePill(); layoutHeaders(); });

/* ---------- BOARD: one shared canvas (text, checklists, images, arrows) ---------- */
const BD = (() => {
  const BZ = { min: .2, max: 3 }, LIM = 40000, TOP = 76, BOT = 112, MAXIMG = 1600;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fin = (v, d) => (Number.isFinite(+v) ? +v : d);
  const cl = v => JSON.parse(JSON.stringify(v));
  const SVGNS = 'http://www.w3.org/2000/svg';
  const PLAIN = (() => { const d = document.createElement('div'); try { d.contentEditable = 'plaintext-only'; } catch { /* old engine */ } return d.contentEditable === 'plaintext-only'; })();
  const CE = PLAIN ? 'plaintext-only' : 'true';

  /* ----- data cleaning (also used by import) ----- */
  const newBoard = () => ({ items: [], arrows: [], view: { x: 0, y: 0, z: 1 } });
  function cleanItem(i) {
    const type = ['text', 'check', 'image'].includes(i.type) ? i.type : null; if (!type) return null;
    const o = { id: String(i.id || uid()), type, x: fin(i.x, 0), y: fin(i.y, 0), w: clamp(fin(i.w, 240), 40, 4000) };
    if (type === 'text') o.text = String(i.text || '');
    if (type === 'check') o.checks = (Array.isArray(i.checks) ? i.checks : []).filter(c => c && typeof c === 'object').map(c => ({ id: String(c.id || uid()), text: String(c.text || ''), done: !!c.done }));
    if (type === 'image') { o.img = String(i.img || ''); if (!o.img) return null; o.h = clamp(fin(i.h, o.w * .75), 30, 6000); }
    return o;
  }
  function cleanBoard(b) {
    const o = newBoard(); if (!b || typeof b !== 'object') return o;
    o.items = (Array.isArray(b.items) ? b.items : []).filter(i => i && typeof i === 'object').map(cleanItem).filter(Boolean);
    const ids = new Set(o.items.map(i => i.id)), seen = new Set();
    o.arrows = (Array.isArray(b.arrows) ? b.arrows : []).filter(a => a && ids.has(a.from) && ids.has(a.to) && a.from !== a.to && !seen.has(a.from + '>' + a.to) && seen.add(a.from + '>' + a.to))
      .map(a => ({ id: String(a.id || uid()), from: String(a.from), to: String(a.to) }));
    const v = b.view || {}; o.view = { x: fin(v.x, 0), y: fin(v.y, 0), z: clamp(fin(v.z, 1), BZ.min, BZ.max) };
    return o;
  }

  /* ----- state ----- */
  const imap = new Map(), amap = new Map(), els = new Map(), aels = new Map(), hs = new Map(), imgCache = new Map();
  let draftItem = null, sel = null, editing = null, arrowMode = null;
  let hist = [], hp = 0, vw = 0, vh = 0, vr = { left: 0, top: 0 };
  const app = $('#app'), vp = $('#bView'), grid = $('#bGrid'), world = $('#bWorld'), layer = $('#bItems'), arrowG = $('#bArrowG'), svg = $('#bArrows');
  const ov = { root: $('#bSel'), box: $('#sBox'), rs: $('#sRs'), bar: $('#sBar') };
  const isActive = () => $('#boards').classList.contains('active');
  const getItem = id => (draftItem && draftItem.id === id ? draftItem : imap.get(id));
  const getView = () => board.view;
  const rectOf = id => { const it = getItem(id); return it ? { x: it.x, y: it.y, w: it.w, h: it.type === 'image' ? it.h : (hs.get(id) || 48) } : null; };
  const toWorld = (cx, cy) => ({ x: (cx - vr.left - board.view.x) / board.view.z, y: (cy - vr.top - board.view.y) / board.view.z });
  const centerWorld = () => { const v = board.view; return { x: (vw / 2 - v.x) / v.z, y: (TOP + (vh - TOP - BOT) / 2 - v.y) / v.z }; };
  const measure = () => { vw = vp.clientWidth; vh = vp.clientHeight; const r = vp.getBoundingClientRect(); vr = { left: r.left, top: r.top }; };

  /* ----- frame scheduler: pan / zoom / drag only touch transforms ----- */
  let fr = 0, dView = false; const dA = new Set();
  const sched = () => { if (!fr) fr = requestAnimationFrame(frame); };
  const touchView = () => { dView = true; sched(); };
  const arrowsOf = id => board.arrows.filter(a => a.from === id || a.to === id);
  const touchItem = id => { arrowsOf(id).forEach(a => dA.add(a.id)); sched(); };
  function frame() {
    fr = 0;
    if (dView) { dView = false; paintView(); }
    if (dA.size) { dA.forEach(id => { const a = amap.get(id); if (a) updateArrow(a); }); dA.clear(); }
    layoutSel();
  }
  let mvT = 0, lastZ = 0, lastHit = 0;
  const moving = () => { world.classList.add('mv'); clearTimeout(mvT); mvT = setTimeout(() => world.classList.remove('mv'), 200); };
  function clampView() {
    const v = board.view; v.z = clamp(v.z, BZ.min, BZ.max);
    if (!vw) return;
    const cx = clamp((vw / 2 - v.x) / v.z, -LIM, LIM), cy = clamp((vh / 2 - v.y) / v.z, -LIM, LIM);
    v.x = vw / 2 - cx * v.z; v.y = vh / 2 - cy * v.z;
  }
  function paintView() {
    const v = board.view;
    world.style.transform = `translate3d(${v.x}px,${v.y}px,0) scale(${v.z})`;
    let s = 20; while (s * v.z < 10) s *= 5;               // grid gets coarser when zoomed out
    const p1 = s * v.z;
    grid.style.cssText = `--s1:${p1}px;--s5:${p1 * 5}px;--gx:${v.x}px;--gy:${v.y}px;--a1:${clamp((p1 - 9) / 9, 0, 1).toFixed(2)}`;
    if (lastZ !== v.z) {
      lastZ = v.z; $('#bZoom').textContent = Math.round(v.z * 100) + '%';
      const hit = Math.round(Math.max(26, 30 / v.z)); if (hit !== lastHit) { lastHit = hit; svg.style.setProperty('--hit', hit); }
    }
  }
  function zoomAt(sx, sy, z2) { // keep the world point under (sx, sy) where it is
    const v = board.view, z = clamp(z2, BZ.min, BZ.max), wx = (sx - v.x) / v.z, wy = (sy - v.y) / v.z;
    v.z = z; v.x = sx - wx * z; v.y = sy - wy * z; clampView();
  }
  let saveT = 0;
  const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(() => save('board'), 350); };
  let tw = 0;
  function flyTo(to) {
    cancelAnimationFrame(tw);
    const a = { ...board.view }, t0 = performance.now(), D = animOn() ? 380 : 0;
    const step = now => {
      const k = D ? Math.min(1, (now - t0) / D) : 1, e = 1 - Math.pow(1 - k, 3), v = board.view;
      v.x = a.x + (to.x - a.x) * e; v.y = a.y + (to.y - a.y) * e; v.z = a.z + (to.z - a.z) * e;
      moving(); paintView(); layoutSel();
      if (k < 1) tw = requestAnimationFrame(step); else { clampView(); paintView(); saveSoon(); }
    };
    tw = requestAnimationFrame(step);
  }
  function bbox() {
    if (!board.items.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    board.items.forEach(i => { const r = rectOf(i.id); x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); });
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  function fit() { // "To content"
    finishEdit();
    const b = bbox(), areaH = Math.max(80, vh - TOP - BOT), cy = TOP + areaH / 2;
    if (!b) return flyTo({ x: vw / 2, y: cy, z: 1 });
    const z = clamp(Math.min((vw - 56) / Math.max(b.w, 1), (areaH - 24) / Math.max(b.h, 1)), BZ.min, 1.5);
    flyTo({ z, x: vw / 2 - (b.x + b.w / 2) * z, y: cy - (b.y + b.h / 2) * z });
  }

  /* ----- elements ----- */
  const readText = el => String(el.innerText ?? el.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\n$/, '');
  const rowHTML = c => `<div class="cr${c.done ? ' done' : ''}" data-cid="${c.id}"><span class="cbx">${icon('check')}</span><div class="ct" contenteditable="${CE}" spellcheck="false" data-ph="${esc(t('itemHolder'))}">${esc(c.text)}</div></div>`;
  const renderRows = (el, it) => { el.querySelector('.rows').innerHTML = it.checks.map(rowHTML).join(''); };
  const pastePlain = e => { e.preventDefault(); const s = (e.clipboardData || window.clipboardData).getData('text/plain'); document.execCommand('insertText', false, e.target.closest('.ct') ? s.replace(/\s*\n+\s*/g, ' ') : s); };

  function makeEl(it) {
    const el = document.createElement('div');
    el.className = 'it ' + it.type; el.dataset.id = it.id;
    if (it.type === 'text') {
      el.innerHTML = `<div class="tb" contenteditable="${CE}" spellcheck="false" data-ph="${esc(t('textHolder'))}"></div>`;
      const tb = el.firstChild;
      tb.addEventListener('blur', () => { if (editing && editing.el === el) finishEdit(); });
      tb.addEventListener('input', () => { if (!tb.textContent) tb.innerHTML = ''; ensureVisible(); });
      tb.addEventListener('paste', pastePlain);
      tb.addEventListener('keydown', e => { if (e.key === 'Escape') tb.blur(); });
    } else if (it.type === 'check') {
      el.innerHTML = `<div class="rows"></div><div class="cadd-b">${icon('plus')}<span>${esc(t('addItem'))}</span></div>`;
      el.addEventListener('input', e => {
        const ct = e.target.closest('.ct'); if (!ct) return;
        const o = getItem(el.dataset.id), c = o && o.checks.find(x => x.id === ct.parentNode.dataset.cid);
        if (c) c.text = readText(ct).replace(/\n/g, ' ');
        if (!ct.textContent) ct.innerHTML = '';
        ensureVisible();
      });
      el.addEventListener('paste', e => { if (e.target.closest('.ct')) pastePlain(e); });
      el.addEventListener('keydown', e => {
        const ct = e.target.closest('.ct'); if (!ct) return;
        const o = getItem(el.dataset.id), row = ct.parentNode, i = o.checks.findIndex(x => x.id === row.dataset.cid);
        if (e.key === 'Enter') { e.preventDefault(); focusEnd(insertRow(o, el, i + 1)); }
        else if (e.key === 'Backspace' && !readText(ct) && o.checks.length > 1) {
          e.preventDefault(); o.checks.splice(i, 1); row.remove();
          focusEnd($$('.ct', el)[Math.max(0, i - 1)]);
        } else if (e.key === 'Escape') ct.blur();
      });
      el.addEventListener('focusout', () => setTimeout(() => { if (editing && editing.el === el && !el.contains(document.activeElement)) finishEdit(); }, 0));
      renderRows(el, it);
    } else {
      el.innerHTML = '<img alt="" draggable="false">';
    }
    return el;
  }
  function insertRow(it, el, idx) {
    const c = { id: uid(), text: '', done: false };
    it.checks.splice(idx, 0, c);
    const tmp = document.createElement('div'); tmp.innerHTML = rowHTML(c);
    const rows = $('.rows', el); rows.insertBefore(tmp.firstChild, rows.children[idx] || null);
    return rows.children[idx].querySelector('.ct');
  }
  function focusEnd(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    try { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch { /* ignore */ }
  }
  function place(it, el = els.get(it.id)) {
    if (!el) return;
    el.style.transform = `translate(${it.x}px,${it.y}px)`;
    el.style.width = it.w + 'px';
    if (it.type === 'image') el.style.height = it.h + 'px';
  }
  function paint(it) {
    const el = els.get(it.id); if (!el) return; place(it, el);
    const busy = editing && editing.id === it.id;
    if (it.type === 'text' && !busy) el.firstChild.textContent = it.text;
    else if (it.type === 'check' && !busy) renderRows(el, it);
  }
  function loadImg(o) {
    const el = els.get(o.id), im = el && el.querySelector('img'); if (!im) return;
    const hit = imgCache.get(o.img); if (hit) { im.src = hit; return; }
    store.get('img:' + o.img).then(d => { if (d) { imgCache.set(o.img, d); im.src = d; } else el.classList.add('missing'); }).catch(() => {});
  }
  const ro = new ResizeObserver(list => {
    list.forEach(e => {
      const id = e.target.dataset.id, h = Math.round(e.borderBoxSize && e.borderBoxSize[0] ? e.borderBoxSize[0].blockSize : e.contentRect.height);
      if (hs.get(id) === h) return; hs.set(id, h); touchItem(id);
    });
  });
  function mountItem(o) {
    const el = makeEl(o); els.set(o.id, el); layer.append(el); ro.observe(el);
    place(o, el); paint(o); if (o.type === 'image') loadImg(o);
    return el;
  }
  function dropEl(id) { const el = els.get(id); if (el) { ro.unobserve(el); el.remove(); } els.delete(id); hs.delete(id); }

  /* ----- arrows ----- */
  const SIDE = { r: [1, 0], l: [-1, 0], b: [0, 1], t: [0, -1] };
  const pt = (R, s) => (s === 'r' ? { x: R.x + R.w, y: R.y + R.h / 2 } : s === 'l' ? { x: R.x, y: R.y + R.h / 2 } : s === 'b' ? { x: R.x + R.w / 2, y: R.y + R.h } : { x: R.x + R.w / 2, y: R.y });
  function arrowGeom(A, B) { // an arrow always sticks to the sides of the two blocks that face each other
    const dx = (B.x + B.w / 2) - (A.x + A.w / 2), dy = (B.y + B.h / 2) - (A.y + A.h / 2);
    let sa, sb;
    if (Math.abs(dx) / (A.w / 2 + B.w / 2) > Math.abs(dy) / (A.h / 2 + B.h / 2)) { sa = dx > 0 ? 'r' : 'l'; sb = dx > 0 ? 'l' : 'r'; }
    else { sa = dy > 0 ? 'b' : 't'; sb = dy > 0 ? 't' : 'b'; }
    const p = pt(A, sa), q = pt(B, sb), len = clamp(Math.hypot(q.x - p.x, q.y - p.y) * .4, 32, 200), n = SIDE[sa], m = SIDE[sb];
    const c1 = { x: p.x + n[0] * len, y: p.y + n[1] * len }, c2 = { x: q.x + m[0] * len, y: q.y + m[1] * len };
    return { d: `M${p.x} ${p.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${q.x} ${q.y}`, mid: { x: (p.x + 3 * c1.x + 3 * c2.x + q.x) / 8, y: (p.y + 3 * c1.y + 3 * c2.y + q.y) / 8 } };
  }
  function mountArrow(a) {
    const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', 'arw'); g.dataset.id = a.id;
    const hit = document.createElementNS(SVGNS, 'path'); hit.setAttribute('class', 'ahit');
    const ln = document.createElementNS(SVGNS, 'path'); ln.setAttribute('class', 'aline'); ln.setAttribute('marker-end', 'url(#bAh)');
    g.append(hit, ln); arrowG.append(g); aels.set(a.id, g); updateArrow(a);
  }
  function updateArrow(a) {
    const g = aels.get(a.id), A = rectOf(a.from), B = rectOf(a.to); if (!g || !A || !B) return;
    const r = arrowGeom(A, B); g.firstChild.setAttribute('d', r.d); g.lastChild.setAttribute('d', r.d); g._mid = r.mid;
  }

  /* ----- model operations: every change is a list of ops, so Undo / Redo is exact ----- */
  function addObj(k, o, i) {
    const arr = k === 'i' ? board.items : board.arrows;
    if (i == null || i > arr.length) i = arr.length;
    arr.splice(i, 0, o);
    if (k === 'i') {
      imap.set(o.id, o); const el = mountItem(o);
      if (i < arr.length - 1) layer.insertBefore(el, els.get(arr[i + 1].id) || null);
    } else { amap.set(o.id, o); mountArrow(o); }
    updEmpty(); sched();
  }
  function rmObj(k, id) {
    if (k === 'i') {
      const it = imap.get(id); if (!it) return;
      board.items.splice(board.items.indexOf(it), 1); imap.delete(id); dropEl(id);
      if (editing && editing.id === id) { editing = null; app.classList.remove('kb'); }
    } else {
      const a = amap.get(id); if (!a) return;
      board.arrows.splice(board.arrows.indexOf(a), 1); amap.delete(id);
      const g = aels.get(id); if (g) g.remove(); aels.delete(id);
    }
    if (sel && sel.id === id) sel = null;
    updEmpty(); sched();
  }
  function setProps(k, id, p) {
    const o = (k === 'i' ? imap : amap).get(id); if (!o) return;
    Object.assign(o, cl(p));
    if (k === 'i') { paint(o); touchItem(id); }
    sched();
  }
  const OPS = {
    add: { redo: o => addObj(o.k, o.obj, o.i), undo: o => rmObj(o.k, o.obj.id) },
    del: { redo: o => { o.i = (o.k === 'i' ? board.items : board.arrows).indexOf(o.obj); rmObj(o.k, o.obj.id); }, undo: o => addObj(o.k, o.obj, o.i) },
    upd: { redo: o => setProps(o.k, o.id, o.a), undo: o => setProps(o.k, o.id, o.b) }
  };
  function record(ops) {
    hist.length = hp; hist.push(ops); if (hist.length > 300) hist.shift();
    hp = hist.length; updUR(); saveSoon();
  }
  const act = ops => { ops.forEach(o => OPS[o.t].redo(o)); record(ops); };
  function afterHist() { updUR(); updEmpty(); layoutSel(); saveSoon(); buzz(8); }
  function hUndo() { finishEdit(); if (hp <= 0) return; const ops = hist[--hp]; for (let i = ops.length - 1; i >= 0; i--) OPS[ops[i].t].undo(ops[i]); afterHist(); }
  function hRedo() { finishEdit(); if (hp >= hist.length) return; const ops = hist[hp++]; ops.forEach(o => OPS[o.t].redo(o)); afterHist(); }
  function updUR() { $('#bUndo').disabled = hp <= 0; $('#bRedo').disabled = hp >= hist.length; }
  function updEmpty() { $('#bEmpty').hidden = board.items.length > 0 || !!draftItem; }
  const itemOps = id => [...arrowsOf(id).map(a => ({ t: 'del', k: 'a', obj: a })), { t: 'del', k: 'i', obj: imap.get(id) }];
  function deleteItem(id) {
    if (!imap.get(id)) return;
    if (editing && editing.id === id) { editing.el.classList.remove('editing'); editing = null; app.classList.remove('kb'); if (document.activeElement) document.activeElement.blur(); }
    act(itemOps(id)); buzz(15, 'del');
    toast(t('deleted'), t('undo'), hUndo);
  }
  function deleteArrow(id) { const a = amap.get(id); if (!a) return; act([{ t: 'del', k: 'a', obj: a }]); buzz(10, 'del'); toast(t('deleted'), t('undo'), hUndo); }

  /* ----- selection overlay (screen space, constant size handles) ----- */
  function select(s) {
    if (sel && sel.kind === 'arrow') { const g = aels.get(sel.id); if (g) { g.classList.remove('sel'); g.lastChild.setAttribute('marker-end', 'url(#bAh)'); } }
    sel = s;
    if (s && s.kind === 'arrow') { const g = aels.get(s.id); if (g) { g.classList.add('sel'); g.lastChild.setAttribute('marker-end', 'url(#bAhS)'); } }
    layoutSel();
  }
  function layoutSel() {
    if (!sel || !isActive() || arrowMode) { ov.root.hidden = true; return; }
    const v = board.view, z = v.z, bar = ov.bar, bw = bar.offsetWidth || 140;
    let bx, by;
    bar.dataset.k = sel.kind;
    if (sel.kind === 'item') {
      const r = rectOf(sel.id); if (!r) { ov.root.hidden = true; return; }
      const l = r.x * z + v.x, tp = r.y * z + v.y, w = r.w * z, h = r.h * z;
      ov.box.style.cssText = `display:block;transform:translate(${l}px,${tp}px);width:${w}px;height:${h}px`;
      ov.rs.style.cssText = `display:grid;transform:translate(${l + w}px,${tp + h}px)`;
      bx = clamp(l, 8, Math.max(8, vw - bw - 8)); by = tp - 54; if (by < 64) by = tp + h + 14;
    } else {
      const g = aels.get(sel.id), m = g && g._mid; if (!m) { ov.root.hidden = true; return; }
      ov.box.style.display = 'none'; ov.rs.style.display = 'none';
      bx = clamp(m.x * z + v.x - bw / 2, 8, Math.max(8, vw - bw - 8)); by = m.y * z + v.y - 56;
    }
    by = clamp(by, 64, Math.max(64, vh - 70));
    bar.style.transform = `translate(${bx}px,${by}px)`;
    ov.root.hidden = false;
  }
  function track(e, move, end) { // drag on a handle with its own pointer capture
    const el = e.currentTarget, id = e.pointerId, sx = e.clientX, sy = e.clientY;
    try { el.setPointerCapture(id); } catch { /* ignore */ }
    const mv = ev => { if (ev.pointerId === id) move(ev.clientX - sx, ev.clientY - sy); };
    const up = ev => {
      if (ev.pointerId !== id) return;
      el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      end(ev.clientX - sx, ev.clientY - sy, ev.type === 'pointercancel');
    };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }
  ov.root.addEventListener('pointerdown', e => e.stopPropagation());
  ov.root.addEventListener('mousedown', e => e.preventDefault()); // keep the keyboard / caret while using the handles
  $('#sGrip').addEventListener('pointerdown', e => {
    e.preventDefault(); if (!sel || sel.kind !== 'item') return;
    const it = getItem(sel.id), x0 = it.x, y0 = it.y, z = board.view.z; moving();
    track(e, (dx, dy) => { it.x = x0 + dx / z; it.y = y0 + dy / z; place(it); touchItem(it.id); },
      (dx, dy, cancel) => {
        it.x = cancel ? x0 : Math.round(it.x); it.y = cancel ? y0 : Math.round(it.y); place(it); touchItem(it.id);
        if (it.x !== x0 || it.y !== y0) record([{ t: 'upd', k: 'i', id: it.id, b: { x: x0, y: y0 }, a: { x: it.x, y: it.y } }]);
      });
  });
  ov.rs.addEventListener('pointerdown', e => {
    e.preventDefault(); if (!sel || sel.kind !== 'item') return;
    const it = getItem(sel.id), w0 = it.w, h0 = it.h, z = board.view.z, minW = it.type === 'image' ? 48 : it.type === 'check' ? 140 : 90; moving();
    track(e, dx => {
      it.w = clamp(Math.round(w0 + dx / z), minW, 4000);
      if (it.type === 'image') it.h = Math.round(it.w * h0 / w0);
      place(it); touchItem(it.id);
    }, (dx, dy, cancel) => {
      if (cancel) { it.w = w0; if (it.type === 'image') it.h = h0; place(it); touchItem(it.id); return; }
      if (it.w !== w0) {
        const b = { w: w0 }, a = { w: it.w }; if (it.type === 'image') { b.h = h0; a.h = it.h; }
        record([{ t: 'upd', k: 'i', id: it.id, b, a }]);
      }
    });
  });
  $('#sArrow').addEventListener('click', () => { if (sel && sel.kind === 'item') startArrow(sel.id); });
  $('#sDel').addEventListener('click', () => { if (!sel) return; sel.kind === 'item' ? deleteItem(sel.id) : deleteArrow(sel.id); });

  /* ----- text / checklist editing ----- */
  function placeCaret(el, x, y) {
    try {
      let r = null;
      if (x != null && document.caretRangeFromPoint) r = document.caretRangeFromPoint(x, y);
      else if (x != null && document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true); } }
      if (!r || !el.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(el); r.collapse(false); }
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    } catch { /* ignore */ }
  }
  function startEdit(id, cx, cy, opt = {}) {
    const it = getItem(id), el = els.get(id); if (!it || !el || it.type === 'image') return;
    if (editing && editing.id === id) { if (!opt.add) return; }
    else finishEdit(true);
    if (!editing || editing.id !== id) editing = { id, it, el, before: it.type === 'text' ? it.text : cl(it.checks) };
    el.classList.add('editing');
    select({ kind: 'item', id });
    let tgt;
    if (it.type === 'text') tgt = el.firstChild;
    else {
      if (opt.add) tgt = insertRow(it, el, it.checks.length);
      else tgt = (opt.row && el.querySelector(`.cr[data-cid="${opt.row}"] .ct`)) || $$('.ct', el).pop();
    }
    tgt.focus({ preventScroll: true });
    if (opt.add) focusEnd(tgt); else placeCaret(tgt, cx, cy);
    setTimeout(ensureVisible, 80);
  }
  function dropDraft(it) { draftItem = null; dropEl(it.id); if (sel && sel.id === it.id) sel = null; updEmpty(); layoutSel(); }
  function finishEdit(keep) {
    const ed = editing; if (!ed) return; editing = null;
    const { it, el } = ed; el.classList.remove('editing'); app.classList.remove('kb');
    if (!keep && el.contains(document.activeElement)) document.activeElement.blur();
    const isDraft = draftItem === it;
    if (it.type === 'text') {
      const text = readText(el.firstChild).replace(/\s+$/, '');
      if (isDraft) {
        if (!text.trim()) return dropDraft(it);
        it.text = text; draftItem = null; board.items.push(it); imap.set(it.id, it);
        record([{ t: 'add', k: 'i', obj: it, i: board.items.length - 1 }]); updEmpty();
      } else if (!text.trim()) { it.text = ed.before; paint(it); deleteItem(it.id); }
      else if (text !== ed.before) { it.text = text; record([{ t: 'upd', k: 'i', id: it.id, b: { text: ed.before }, a: { text } }]); }
    } else {
      const rows = it.checks.filter(c => c.text.trim()).map(c => ({ ...c, text: c.text.trim() }));
      if (isDraft) {
        if (!rows.length) return dropDraft(it);
        it.checks = rows; renderRows(el, it); draftItem = null; board.items.push(it); imap.set(it.id, it);
        record([{ t: 'add', k: 'i', obj: it, i: board.items.length - 1 }]); updEmpty();
      } else if (!rows.length) { it.checks = ed.before; paint(it); deleteItem(it.id); }
      else {
        it.checks = rows; renderRows(el, it);
        if (JSON.stringify(rows) !== JSON.stringify(ed.before)) record([{ t: 'upd', k: 'i', id: it.id, b: { checks: ed.before }, a: { checks: cl(rows) } }]);
      }
    }
    layoutSel(); saveSoon();
  }
  function ensureVisible() { // keep the caret above the on-screen keyboard
    if (!editing) return;
    const r0 = vp.getBoundingClientRect(); let r = null;
    const s = getSelection();
    if (s && s.rangeCount && editing.el.contains(s.anchorNode)) { const rs = s.getRangeAt(0).getClientRects(); if (rs.length) r = rs[rs.length - 1]; }
    if (!r || (!r.height && !r.width)) r = editing.el.getBoundingClientRect();
    const topLim = r0.top + 112, botLim = r0.bottom - 28;
    let dy = 0;
    if (r.bottom > botLim) dy = botLim - r.bottom;
    if (r.top + dy < topLim && r.top < topLim) dy = topLim - r.top;
    if (Math.abs(dy) > 1) { board.view.y += dy; clampView(); touchView(); saveSoon(); }
  }
  function mountDraft(it) {
    finishEdit(true);
    draftItem = it; mountItem(it); updEmpty();
    return it;
  }
  function createText(p, sx, sy) {
    if (sx != null && board.view.z < .7) { zoomAt(sx, sy, 1); paintView(); }   // typing at 20% would be unreadable
    const it = mountDraft({ id: uid(), type: 'text', x: Math.round(p.x - 12), y: Math.round(p.y - 18), w: 240, text: '' });
    startEdit(it.id, null, null);
  }
  function createCheck(p) {
    const it = mountDraft({ id: uid(), type: 'check', x: Math.round(p.x - 12), y: Math.round(p.y - 18), w: 260, checks: [{ id: uid(), text: '', done: false }] });
    startEdit(it.id, null, null);
  }
  function toggleCheck(id, cid) {
    const it = getItem(id), c = it && it.checks.find(x => x.id === cid); if (!c) return;
    const el = els.get(id), row = el.querySelector(`.cr[data-cid="${cid}"]`);
    if (editing && editing.id === id) { c.done = !c.done; if (row) row.classList.toggle('done', c.done); }   // part of the running edit
    else { const b = cl(it.checks); c.done = !c.done; if (row) row.classList.toggle('done', c.done); record([{ t: 'upd', k: 'i', id, b: { checks: b }, a: { checks: cl(it.checks) } }]); }
    buzz();
  }
  function centerSpot() { // free place near the middle of the screen
    const c = centerWorld(); let x = Math.round(c.x), y = Math.round(c.y), n = 0;
    while (n++ < 12 && board.items.some(i => Math.abs(i.x + i.w / 2 - x) < 16 && Math.abs(i.y + 24 - y) < 24)) { x += 28; y += 28; }
    return { x, y };
  }

  /* ----- arrows: tap the first block, tap the second ----- */
  const hint = $('#bHint');
  function showHint(key) { $('#bHintTxt').textContent = t(key); hint.dataset.k = key; hint.hidden = false; }
  function startArrow(from) {
    finishEdit(); select(null); arrowMode = { from: from || null };
    if (from && els.get(from)) els.get(from).classList.add('pick');
    showHint(from ? 'hintArrow2' : 'hintArrow1');
  }
  function cancelArrow() {
    if (!arrowMode) return; arrowMode = null; hint.hidden = true;
    $$('.it.pick', layer).forEach(e => e.classList.remove('pick'));
  }
  function arrowPick(id) {
    if (!arrowMode.from) { arrowMode.from = id; els.get(id).classList.add('pick'); showHint('hintArrow2'); buzz(8); return; }
    const from = arrowMode.from; if (from === id) return;
    cancelArrow();
    if (board.arrows.some(a => a.from === from && a.to === id)) { toast(t('arrowExists')); return; }
    const a = { id: uid(), from, to: id };
    act([{ t: 'add', k: 'a', obj: a, i: board.arrows.length }]); select({ kind: 'arrow', id: a.id }); buzz(12, 'save');
  }
  $('#bHintX').addEventListener('click', cancelArrow);

  /* ----- gestures: 1 finger tap / drag, 2 fingers zoom + pan ----- */
  const ptrs = new Map(); let g = null, lastCreate = 0;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  function startPinch() {
    if (g && g.type === 'drag') { g.it.x = g.x0; g.it.y = g.y0; place(g.it); touchItem(g.it.id); }
    const [a, b] = [...ptrs.values()], v = board.view, c = mid(a, b);
    g = { type: 'pinch', d0: Math.max(1, dist(a, b)), z0: v.z, w0: { x: (c.x - vr.left - v.x) / v.z, y: (c.y - vr.top - v.y) / v.z } };
    moving();
  }
  function pinchMove() {
    const [a, b] = [...ptrs.values()]; if (!a || !b) return;
    const c = mid(a, b), v = board.view; v.z = clamp(g.z0 * dist(a, b) / g.d0, BZ.min, BZ.max);
    v.x = c.x - vr.left - g.w0.x * v.z; v.y = c.y - vr.top - g.w0.y * v.z;
    clampView(); moving(); touchView();
  }
  vp.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    cancelAnimationFrame(tw); measure();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { startPinch(); return; }
    if (ptrs.size > 2) return;
    const tg = e.target, itEl = tg.closest('.it'), ar = tg.closest('.arw');
    const native = itEl && itEl.classList.contains('editing') && tg.closest('.tb,.ct');   // caret / selection inside the text being edited
    g = { type: native ? 'native' : 'pending', pid: e.pointerId, sx: e.clientX, sy: e.clientY, tg, kind: ar ? 'arrow' : itEl ? 'item' : 'empty', id: ar ? ar.dataset.id : itEl ? itEl.dataset.id : null };
  });
  vp.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (!g) return;
    if (g.type === 'pinch') { pinchMove(); return; }
    if (e.pointerId !== g.pid) return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (g.type === 'pending') {
      if (Math.hypot(dx, dy) < (e.pointerType === 'mouse' ? 4 : 9)) return;
      try { vp.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (g.kind === 'item' && !arrowMode && getItem(g.id)) {
        finishEdit();
        const it = getItem(g.id); g.type = 'drag'; g.it = it; g.x0 = it.x; g.y0 = it.y; select({ kind: 'item', id: it.id });
      } else { g.type = 'pan'; g.v0 = { ...board.view }; }
      moving();
    }
    if (g.type === 'drag') { const z = board.view.z; g.it.x = g.x0 + dx / z; g.it.y = g.y0 + dy / z; place(g.it); touchItem(g.it.id); }
    else if (g.type === 'pan') { const v = board.view; v.x = g.v0.x + dx; v.y = g.v0.y + dy; clampView(); moving(); touchView(); }
  });
  function onUp(e, cancel) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    const s = g; if (!s) return;
    if (s.type === 'pinch') { if (ptrs.size < 2) { g = ptrs.size ? { type: 'ignore' } : null; saveSoon(); } return; }
    if (s.type === 'ignore') { if (!ptrs.size) g = null; return; }
    if (e.pointerId !== s.pid) return;
    g = null;
    if (s.type === 'pending' && !cancel) tap(s, e);
    else if (s.type === 'drag') {
      const it = s.it; it.x = cancel ? s.x0 : Math.round(it.x); it.y = cancel ? s.y0 : Math.round(it.y); place(it); touchItem(it.id);
      if (it.x !== s.x0 || it.y !== s.y0) record([{ t: 'upd', k: 'i', id: it.id, b: { x: s.x0, y: s.y0 }, a: { x: it.x, y: it.y } }]);
    } else if (s.type === 'pan') saveSoon();
  }
  vp.addEventListener('pointerup', e => onUp(e, false));
  vp.addEventListener('pointercancel', e => onUp(e, true));
  function tap(s, e) {
    if (arrowMode) { if (s.kind === 'item') arrowPick(s.id); else cancelArrow(); return; }
    if (s.kind === 'arrow') { finishEdit(); select({ kind: 'arrow', id: s.id }); return; }
    if (s.kind === 'item') {
      const it = getItem(s.id); if (!it) return;
      if (it.type === 'text') { startEdit(it.id, e.clientX, e.clientY); return; }
      if (it.type === 'check') {
        const cb = s.tg.closest('.cbx');
        if (cb) { toggleCheck(it.id, cb.closest('.cr').dataset.cid); select({ kind: 'item', id: it.id }); return; }
        if (s.tg.closest('.cadd-b')) { startEdit(it.id, 0, 0, { add: true }); return; }
        const row = s.tg.closest('.cr'); startEdit(it.id, e.clientX, e.clientY, { row: row && row.dataset.cid }); return;
      }
      finishEdit(); select({ kind: 'item', id: it.id }); return;
    }
    // empty place: ONE tap = a new text block right there, ready to type
    const now = performance.now(); if (now - lastCreate < 220) return; lastCreate = now;
    select(null); createText(toWorld(e.clientX, e.clientY), e.clientX - vr.left, e.clientY - vr.top);
  }
  vp.addEventListener('wheel', e => {
    e.preventDefault(); measure();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - vr.left, e.clientY - vr.top, board.view.z * Math.exp(-e.deltaY * .01));
    else { board.view.x -= e.deltaX; board.view.y -= e.deltaY; clampView(); }
    moving(); touchView(); saveSoon();
  }, { passive: false });
  vp.addEventListener('contextmenu', e => { if (!e.target.closest('.tb,.ct')) e.preventDefault(); });
  vp.addEventListener('dragstart', e => e.preventDefault());

  /* ----- header, + menu, images ----- */
  $('#bUndo').addEventListener('click', hUndo);
  $('#bRedo').addEventListener('click', hRedo);
  $('#bFit').addEventListener('click', fit);
  $('#bZoom').addEventListener('click', () => {
    const v = board.view, c = { x: (vw / 2 - v.x) / v.z, y: (vh / 2 - v.y) / v.z };
    flyTo({ z: 1, x: vw / 2 - c.x, y: vh / 2 - c.y });
  });
  const menu = $('#toolMenu'), plus = $('#plusBtn');
  const closeMenu = () => { menu.classList.remove('show'); plus.classList.remove('open'); };
  function plusClick() {
    const scr = $('.screen.active:not(.editor)'), id = scr ? scr.id : 'notes';
    if (id === 'boards') { const on = !menu.classList.contains('show'); menu.classList.toggle('show', on); plus.classList.toggle('open', on); if (on) $('#toast').classList.remove('show'); return; }
    closeMenu();
    if (id === 'tasks') { originEl = plus; pushHash('#/task'); } else openNoteUI(null, plus);
  }
  plus.addEventListener('click', e => { e.stopPropagation(); plusClick(); });
  document.addEventListener('click', e => { if (!e.target.closest('#toolMenu') && !e.target.closest('#plusBtn')) closeMenu(); });
  menu.addEventListener('click', e => {
    const b = e.target.closest('[data-tool]'); if (!b) return;
    const tool = b.dataset.tool; closeMenu(); cancelArrow(); measure();
    if (tool === 'text') { const c = centerSpot(); createText({ x: c.x - 108, y: c.y }); }
    else if (tool === 'check') { const c = centerSpot(); createCheck({ x: c.x - 118, y: c.y }); }
    else if (tool === 'image') $('#bImgFile').click();
    else if (tool === 'arrow') { if (board.items.length < 2) toast(t('needTwo')); else startArrow(null); }
  });
  async function shrink(file) { // max 1600 px on the long side
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      bmp = await new Promise((ok, no) => { const u = URL.createObjectURL(file), im = new Image(); im.onload = () => { URL.revokeObjectURL(u); ok(im); }; im.onerror = () => no(new Error('image')); im.src = u; });
    }
    const W = bmp.width || bmp.naturalWidth, H = bmp.height || bmp.naturalHeight, k = Math.min(1, MAXIMG / Math.max(W, H));
    const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const c = cv.getContext('2d');
    const png = file.type === 'image/png';
    if (!png) { c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); }
    c.drawImage(bmp, 0, 0, w, h); if (bmp.close) bmp.close();
    return { data: cv.toDataURL(png ? 'image/png' : 'image/jpeg', .85), w, h };
  }
  async function addImage(file) {
    const { data, w, h } = await shrink(file), imgId = uid();
    await store.set('img:' + imgId, data); imgCache.set(imgId, data);
    measure(); const z = board.view.z, dw = Math.round(Math.min(w, 320 / clamp(z, .4, 1))), dh = Math.round(dw * h / w), c = centerSpot();
    const it = { id: uid(), type: 'image', x: c.x - Math.round(dw / 2), y: c.y - Math.round(dh / 2), w: dw, h: dh, img: imgId };
    act([{ t: 'add', k: 'i', obj: it, i: board.items.length }]); select({ kind: 'item', id: it.id }); buzz(12, 'save');
  }
  $('#bImgFile').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { await addImage(f); } catch (err) { console.error(err); toast(t('imgFail')); }
  });

  /* ----- keyboard shortcuts (desktop) ----- */
  document.addEventListener('keydown', e => {
    if (!isActive() || e.target.closest('input,textarea,[contenteditable]')) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? hRedo() : hUndo(); }
    else if (mod && k === 'y') { e.preventDefault(); hRedo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); sel.kind === 'item' ? deleteItem(sel.id) : deleteArrow(sel.id); }
    else if (e.key === 'Escape') { cancelArrow(); select(null); }
  });

  /* ----- keyboard on phones ----- */
  if (window.visualViewport) {
    const f = () => {
      const v = visualViewport;
      app.classList.toggle('kb', v.height < innerHeight - 120 && !!editing);
      document.documentElement.style.setProperty('--vvt', Math.round(v.offsetTop) + 'px');
      if (editing) setTimeout(ensureVisible, 60);
    };
    visualViewport.addEventListener('resize', f); visualViewport.addEventListener('scroll', f);
  }
  new ResizeObserver(() => { measure(); clampView(); touchView(); }).observe(vp);
  const flush = () => { finishEdit(); clearTimeout(saveT); save('board'); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  /* ----- public API used by the rest of the app ----- */
  function mount() {
    cancelAnimationFrame(tw); editing = null; draftItem = null; sel = null; arrowMode = null; hint.hidden = true;
    layer.innerHTML = ''; arrowG.innerHTML = '';
    [imap, amap, els, aels, hs].forEach(m => m.clear());
    board.items.forEach(o => { imap.set(o.id, o); mountItem(o); });
    board.arrows.forEach(a => { amap.set(a.id, a); mountArrow(a); });
    hist = []; hp = 0; updUR(); updEmpty(); measure(); clampView(); paintView(); layoutSel();
  }
  function shown(name) {
    if (name !== 'boards') { finishEdit(); closeMenu(); cancelArrow(); return; }
    requestAnimationFrame(() => { measure(); clampView(); paintView(); layoutSel(); updEmpty(); });
  }
  function lang() {
    $$('.tb', layer).forEach(e => { e.dataset.ph = t('textHolder'); });
    $$('.ct', layer).forEach(e => { e.dataset.ph = t('itemHolder'); });
    $$('.cadd-b span', layer).forEach(e => { e.textContent = t('addItem'); });
    if (!hint.hidden) $('#bHintTxt').textContent = t(hint.dataset.k);
  }
  function reset() { board = newBoard(); mount(); }
  async function collectImages() {
    const out = {};
    for (const it of board.items) {
      if (it.type !== 'image' || out[it.img]) continue;
      const d = imgCache.get(it.img) || await store.get('img:' + it.img);
      if (typeof d === 'string') out[it.img] = d;
    }
    return out;
  }
  async function merge(b, images) { // import: add what is not on the board yet
    const inc = cleanBoard(b), ids = new Set(board.items.map(i => i.id)); let n = 0;
    for (const it of inc.items) {
      if (ids.has(it.id)) continue;
      if (it.type === 'image') {
        const d = images && images[it.img];
        if (typeof d === 'string' && d.startsWith('data:image/')) { try { await store.set('img:' + it.img, d); imgCache.set(it.img, d); } catch { continue; } }
        else if (!(await store.get('img:' + it.img))) continue;
      }
      ids.add(it.id); board.items.push(it); imap.set(it.id, it); mountItem(it); n++;
    }
    inc.arrows.forEach(a => {
      if (amap.has(a.id) || !imap.has(a.from) || !imap.has(a.to) || board.arrows.some(x => x.from === a.from && x.to === a.to)) return;
      board.arrows.push(a); amap.set(a.id, a); mountArrow(a);
    });
    updEmpty(); sched(); saveSoon(); return n;
  }
  return { mount, shown, lang, reset, collectImages, merge, clean: cleanBoard, create: newBoard };
})();

/* ---------- init ---------- */
function renderAll() { if (!ready) return; renderNotes(); renderTasks(); renderTrash(); layoutHeaders(); }
applyTheme();
applyLang();
boot();
