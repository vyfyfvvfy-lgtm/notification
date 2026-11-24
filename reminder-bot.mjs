import Database from 'better-sqlite3';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';

const menu = {
  keyboard: [['Новое напоминание', 'Быстрый таймер'], ['Мои напоминания', 'Часовой пояс']],
  resize_keyboard: true,
  is_persistent: true,
};
const descriptionKeyboard = {
  keyboard: [['Пропустить описание'], ['Отмена']],
  resize_keyboard: true,
  one_time_keyboard: true,
};
const timerMinutes = new Map([
  ['1 минута', 1], ['10 минут', 10], ['1 час', 60],
  ['1 день', 1440], ['3 дня', 4320], ['1 неделя', 10080],
]);
const timerKeyboard = {
  keyboard: [['1 минута', '10 минут', '1 час'], ['1 день', '3 дня', '1 неделя'], ['Отмена']],
  resize_keyboard: true,
};
const timeZones = new Map([
  ['UTC+2 · Калининград', 120],
  ['UTC+3 · Москва', 180],
  ['UTC+4 · Самара', 240],
  ['UTC+5 · Екатеринбург', 300],
  ['UTC+6 · Омск', 360],
  ['UTC+7 · Красноярск', 420],
  ['UTC+8 · Иркутск', 480],
  ['UTC+9 · Якутск', 540],
  ['UTC+10 · Владивосток', 600],
  ['UTC+11 · Магадан', 660],
  ['UTC+12 · Анадырь', 720],
]);
const zoneKeyboard = {
  keyboard: [...Array.from(timeZones.keys(), label => [label]), ['Отмена']],
  resize_keyboard: true,
};
const commands = [
  { command: 'start', description: 'Открыть меню' },
  { command: 'new', description: 'Создать напоминание' },
  { command: 'timer', description: 'Запустить быстрый таймер' },
  { command: 'list', description: 'Мои напоминания' },
  { command: 'timezone', description: 'Настроить часовой пояс' },
  { command: 'delete', description: 'Удалить напоминание по номеру' },
  { command: 'cancel', description: 'Отменить текущий ввод' },
];

function parseOffset(value) {
  const match = /^(?:UTC\s*)?([+-])(\d{1,2})(?::([0-5]\d))?$/i.exec(value);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  const signed = match[1] === '-' ? -minutes : minutes;
  return signed >= -720 && signed <= 840 ? signed : null;
}

function formatOffset(offset) {
  const minutes = Math.abs(offset);
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0');
  return 'UTC' + (offset < 0 ? '-' : '+') + hours + ':' + String(minutes % 60).padStart(2, '0');
}

function localDate(timestamp, offset) {
  const iso = new Date(timestamp + offset * 60_000).toISOString();
  return iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) + ' ' + iso.slice(11, 16);
}

const dayMs = 86_400_000;
const pad = number => String(number).padStart(2, '0');
const weekdays = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const pickerKeyboard = keyboard => ({ keyboard, resize_keyboard: true });
const hourKeyboard = pickerKeyboard([
  ...Array.from({ length: 6 }, (_, row) => Array.from({ length: 4 }, (_, col) => pad(row * 4 + col) + ':…')),
  ['Другая дата', 'Отмена'],
]);
const minuteKeyboard = pickerKeyboard([
  ...Array.from({ length: 3 }, (_, row) => Array.from({ length: 4 }, (_, col) => ':' + pad((row * 4 + col) * 5))),
  ['Другой час', 'Другая дата'], ['Отмена'],
]);

function parseDate(value, offset) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/.exec(value);
  if (!match) return NaN;
  const [, day, month, year, hour, minute] = match;
  const timestamp = Date.parse(year + '-' + month + '-' + day + 'T' + hour + ':' + minute + ':00Z');
  const utc = timestamp - offset * 60_000;
  return Number.isFinite(utc) && localDate(utc, offset) === [day, month, year].join('.') + ' ' + hour + ':' + minute
    ? utc : NaN;
}

export function createBot(path, api, now = Date.now) {
  const db = new Database(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER PRIMARY KEY,
      utc_offset INTEGER,
      draft TEXT
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      due_at INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      next_attempt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reminder_delivery ON reminders(next_attempt, id);
    CREATE INDEX IF NOT EXISTS reminder_owner ON reminders(chat_id, due_at, id);
  `);
  const addUser = db.prepare('INSERT OR IGNORE INTO users (chat_id) VALUES (?)');
  const getUser = db.prepare('SELECT utc_offset, draft FROM users WHERE chat_id = ?');
  const saveUser = db.prepare('UPDATE users SET utc_offset = ?, draft = ? WHERE chat_id = ?');
  const add = db.prepare('INSERT INTO reminders (chat_id, due_at, title, description, next_attempt) VALUES (?, ?, ?, ?, ?)');
  const list = db.prepare('SELECT id, due_at, title FROM reminders WHERE chat_id = ? ORDER BY due_at, id LIMIT 11 OFFSET ?');
  const remove = db.prepare('DELETE FROM reminders WHERE chat_id = ? AND id = ?');
  const next = db.prepare('SELECT * FROM reminders WHERE next_attempt <= ? ORDER BY next_attempt, id LIMIT 1');
  const retry = db.prepare('UPDATE reminders SET next_attempt = ? WHERE id = ?');
  let sending = null;

  const reply = (chatId, text, keyboard = menu) =>
    api('sendMessage', { chat_id: chatId, text, reply_markup: keyboard });
  const zonePrompt = 'Выберите часовой пояс по городу. Если вашего пояса нет в списке, введите смещение вручную, например +05:30.';
  const datePrompt = offset => 'Введите дату и время в формате ДД.ММ.ГГГГ ЧЧ:ММ (' + formatOffset(offset) +
    '). Например, ' + localDate(now() + 86_400_000, offset) + '.';

  function handle(message) {
    if (message?.chat?.type !== 'private') return;
    const chatId = message.chat.id;
    const value = message.text?.trim() ?? '';
    addUser.run(chatId);
    let { utc_offset: offset, draft: savedDraft } = getUser.get(chatId);
    const draft = savedDraft ? JSON.parse(savedDraft) : null;
    const save = state => saveUser.run(offset, state ? JSON.stringify(state) : null, chatId);
    const dateKeys = (start, today) => Array.from({ length: 7 }, (_, index) => {
      const timestamp = start + index * dayMs;
      const label = timestamp === today ? 'Сегодня' : timestamp === today + dayMs ? 'Завтра' : weekdays[new Date(timestamp).getUTCDay()];
      return label + ' · ' + localDate(timestamp, 0).slice(0, 10);
    });
    const showDates = (start, prefix = '') => {
      const today = Math.floor((now() + offset * 60_000) / dayMs) * dayMs;
      start = Math.max(start ?? today, today);
      const keys = dateKeys(start, today);
      save({ step: 'date', start, today });
      return reply(chatId, prefix + 'Выберите дату (' + formatOffset(offset) +
        '). Для любой другой даты введите ДД.ММ.ГГГГ.', pickerKeyboard([
        keys.slice(0, 2), keys.slice(2, 4), keys.slice(4, 6), keys.slice(6),
        start > today ? ['← 7 дней', '7 дней →'] : ['7 дней →'], ['Отмена'],
      ]));
    };
    const showHours = (date, prefix = '') => {
      save({ step: 'hour', date });
      return reply(chatId, prefix + date + ' (' + formatOffset(offset) +
        '). Выберите час или введите точное время, например 14:37.', hourKeyboard);
    };
    const setDateTime = (value, keyboard) => {
      const dueAt = parseDate(value, offset);
      if (!Number.isFinite(dueAt)) return reply(chatId, datePrompt(offset), keyboard);
      if (dueAt <= now()) {
        return draft.date
          ? showHours(draft.date, 'Это время уже прошло.\n')
          : showDates(undefined, 'Выберите время в будущем.\n');
      }
      save({ step: 'title', dueAt });
      return reply(chatId, 'Введите название напоминания (до 120 символов).');
    };
    const createReminder = (dueAt, title, description = '') => {
      db.exec('BEGIN');
      try {
        const id = add.run(chatId, dueAt, title, description, dueAt).lastInsertRowid;
        save(null);
        db.exec('COMMIT');
        return id;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    };
    const [command, argument] = value.split(/\s+/, 2);

    if (command === '/start') {
      return reply(chatId, 'Я отправляю личные напоминания. Нажмите «Новое напоминание», чтобы выбрать дату, время и название.');
    }
    if (command === '/cancel' || value === 'Отмена') {
      save(null);
      return reply(chatId, 'Ввод отменён.');
    }
    if (command === '/timezone' || value === 'Часовой пояс') {
      save({ step: 'timezone' });
      return reply(chatId, (offset === null ? '' : 'Текущий пояс — ' + formatOffset(offset) + '.\n') + zonePrompt, zoneKeyboard);
    }
    if (command === '/new' || value === 'Новое напоминание') {
      if (offset !== null) return showDates();
      save({ step: 'timezone', create: true });
      return reply(chatId, zonePrompt, zoneKeyboard);
    }
    if (command === '/timer' || value === 'Быстрый таймер') {
      save({ step: 'timer' });
      return reply(chatId, 'На сколько поставить таймер?', timerKeyboard);
    }
    if (command === '/list' || value === 'Мои напоминания') {
      const page = argument === undefined ? 1 : Number(argument);
      if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) {
        return reply(chatId, 'Укажите номер страницы. Например, /list 2.');
      }
      const rows = list.all(chatId, (page - 1) * 10);
      if (!rows.length) return reply(chatId, page === 1 ? 'У вас пока нет запланированных напоминаний.' : 'На этой странице нет напоминаний.');
      const displayOffset = offset ?? 0;
      const lines = rows.slice(0, 10).map(row => '#' + row.id + ' · ' +
        localDate(row.due_at, displayOffset) + ' · ' + row.title);
      return reply(chatId, 'Мои напоминания (' + formatOffset(displayOffset) + ')\n\n' + lines.join('\n') +
        '\n\nУдаление по номеру, например /delete ' + rows[0].id +
        (rows.length > 10 ? '\nСледующая страница — /list ' + (page + 1) : ''));
    }
    if (command === '/delete') {
      const id = Number(argument);
      if (!Number.isSafeInteger(id) || id < 1) return reply(chatId, 'Укажите номер из списка. Например, /delete 12.');
      if (sending?.id === id && sending.chat_id === chatId) return reply(chatId, 'Это напоминание уже отправляется.');
      return reply(chatId, remove.run(chatId, id).changes ? 'Напоминание удалено.' : 'Напоминание не найдено.');
    }
    if (!draft || value.startsWith('/')) return reply(chatId, 'Выберите действие в меню или отправьте /new.');

    if (draft.step === 'timer') {
      const minutes = timerMinutes.get(value);
      if (!minutes) return reply(chatId, 'Выберите интервал кнопкой ниже.', timerKeyboard);
      const id = createReminder(now() + minutes * 60_000, 'Таймер завершён (' + value + ')');
      return reply(chatId, '⏱ Таймер #' + id + ' запущен. Интервал — ' + value + '.');
    }
    if (draft.step === 'timezone') {
      const selected = timeZones.get(value) ?? parseOffset(value);
      if (selected === null) return reply(chatId, 'Введите смещение в формате +ЧЧ:ММ или выберите кнопку.', zoneKeyboard);
      offset = selected;
      const confirmation = 'Часовой пояс сохранён — ' + formatOffset(offset) + '.';
      if (draft.create) return showDates(undefined, confirmation + '\n');
      save(null);
      return reply(chatId, confirmation);
    }
    if (draft.step === 'date') {
      if (value === '7 дней →' && draft.start !== undefined) return showDates(draft.start + 7 * dayMs);
      if (value === '← 7 дней' && draft.start !== undefined) return showDates(draft.start - 7 * dayMs);
      const date = draft.start !== undefined && dateKeys(draft.start, draft.today).includes(value)
        ? value.slice(-10) : value;
      if (/^\d{2}\.\d{2}\.\d{4}$/.test(date)) {
        const end = parseDate(date + ' 23:59', offset);
        if (!Number.isFinite(end)) return showDates(draft.start, 'Проверьте дату.\n');
        if (end <= now()) return showDates(undefined, 'Эта дата уже прошла.\n');
        return showHours(date);
      }
      if (/^\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}$/.test(value)) return setDateTime(value, menu);
      return showDates(draft.start, 'Введите дату в формате ДД.ММ.ГГГГ или нажмите кнопку.\n');
    }
    if (draft.step === 'hour' || draft.step === 'minute') {
      if (value === 'Другая дата') return showDates();
      if (value === 'Другой час') return showHours(draft.date);
      if (draft.step === 'hour' && /^(?:[01]\d|2[0-3]):…$/.test(value)) {
        const hour = value.slice(0, 2);
        save({ ...draft, step: 'minute', hour });
        return reply(chatId, 'Выберите минуты для ' + hour + ':00 или введите точное время, например ' + hour + ':37.', minuteKeyboard);
      }
      if (draft.step === 'minute' && /^:[0-5]\d$/.test(value)) {
        return setDateTime(draft.date + ' ' + draft.hour + value, minuteKeyboard);
      }
      if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        return setDateTime(draft.date + ' ' + value, draft.step === 'hour' ? hourKeyboard : minuteKeyboard);
      }
      return reply(chatId, 'Выберите время кнопками или введите ЧЧ:ММ.', draft.step === 'hour' ? hourKeyboard : minuteKeyboard);
    }
    if (draft.step === 'title') {
      if (!value || value.length > 120 || /[\r\n]/.test(value)) {
        return reply(chatId, 'Введите название одной строкой (от 1 до 120 символов).');
      }
      save({ ...draft, step: 'description', title: value });
      return reply(chatId, 'Введите описание или нажмите «Пропустить описание».', descriptionKeyboard);
    }
    const description = value === 'Пропустить описание' ? '' : value;
    if ((!message.text && !description) || description.length > 2000) {
      return reply(chatId, 'Введите текст до 2000 символов или пропустите описание.', descriptionKeyboard);
    }
    if (draft.dueAt <= now()) {
      return showDates(undefined, 'Выбранное время уже прошло.\n');
    }
    const id = createReminder(draft.dueAt, draft.title, description);
    return reply(chatId, 'Напоминание #' + id + ' создано.\n' + draft.title + '\n' +
      localDate(draft.dueAt, offset) + ' (' + formatOffset(offset) + ')');
  }

  async function deliver() {
    if (sending) return;
    const row = next.get(now());
    if (!row) return;
    sending = row;
    try {
      await api('sendMessage', {
        chat_id: row.chat_id,
        text: '🔔 ' + row.title + (row.description ? '\n\n' + row.description : ''),
      });
      remove.run(row.chat_id, row.id);
    } catch (error) {
      const delay = error.code === 403 ? 3600 : Math.max(30, error.retryAfter || 0);
      retry.run(now() + delay * 1000, row.id);
      console.error('Отправка отложена для напоминания #' + row.id);
    } finally {
      sending = null;
    }
  }

  return { handle, deliver, close: () => db.close() };
}

function telegram(token) {
  return async (method, payload) => {
    let response;
    let body;
    try {
      response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(method === 'getUpdates' ? 35_000 : 12_000),
      });
      body = await response.json();
    } catch {
      throw new Error('Telegram недоступен');
    }
    if (!response.ok || !body.ok) {
      const code = body.error_code ?? response.status;
      throw Object.assign(new Error('Telegram API HTTP ' + code), {
        code, retryAfter: body.parameters?.retry_after,
      });
    }
    return body.result;
  };
}

async function main() {
  let token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token && process.stdin.isTTY) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { token = (await input.question('Введите токен бота из BotFather: ')).trim(); }
    finally { input.close(); }
  }
  if (!/^\d+:[\w-]+$/.test(token ?? '')) throw new Error('Укажите корректный TELEGRAM_BOT_TOKEN.');
  const api = telegram(token);
  const identity = await api('getMe', {});
  const webhook = await api('getWebhookInfo', {});
  if (webhook.url) throw new Error('У этого бота настроен webhook. Для запуска используйте отдельного бота или отключите webhook.');
  await api('setMyCommands', { commands });
  const dbPath = process.env.REMINDER_DB_PATH || fileURLToPath(new URL('./reminders.sqlite', import.meta.url));
  const bot = createBot(dbPath, api);
  let running = true;
  let offset;
  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });
  console.log('Бот запущен · https://t.me/' + identity.username);

  const deliveryLoop = async () => {
    while (running) {
      await bot.deliver();
      await sleep(1000);
    }
  };
  const pollLoop = async () => {
    while (running) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
        for (const update of updates) {
          if (!running) return;
          offset = update.update_id + 1;
          try { await bot.handle(update.message); }
          catch (error) { console.error('Не удалось обработать сообщение:', error.message); }
        }
      } catch (error) {
        if ([401, 404, 409].includes(error.code)) throw error;
        console.error('Получение сообщений отложено:', error.message);
        await sleep(Math.max(3, error.retryAfter || 0) * 1000);
      }
    }
  };
  const guard = async loop => {
    try { await loop(); }
    finally { running = false; }
  };
  const results = await Promise.allSettled([guard(deliveryLoop), guard(pollLoop)]);
  bot.close();
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
