// Support Assist — работа внутри интерфейса CRM (crm.example.com).
//
// Отличия от версии для прежней CRM, из-за которых файл переписан целиком:
//
//   1. Разметка семантическая, без хешей: .conversation-item, .chat-history,
//      .message-row.incoming / .outgoing, .composer. Цепляемся за классы и
//      aria-label, а не за data-qa-id.
//   2. Каждый ответ обязан нести действие. «Без действия» не останавливает
//      таймер — значит боту оно запрещено: иначе он сам плодит просрочки.
//   3. Ответ закрепляет обращение за оператором. Поэтому дневной лимит теперь
//      не про «заметность», а про то, сколько диалогов вешается лично на вас.
//   4. Отправка подтверждается доставкой (.delivery delivered / failed).
//      «Текст появился в ленте» ответом не считается — правило CRM.
//   5. Бот работает только на своём проекте (по умолчанию VPN) и только
//      внутри рабочего окна смены.
//
// Чего здесь намеренно НЕТ по сравнению с версией для прежней CRM:
//   • команд админ-бота (/ок, /nk, /kr) — в CRM админ-бот в переписку не
//     пишет, ключи живут в отдельной панели «Управление VPN». Пока её
//     разметка не снята, выдавать ключи вслепую нельзя;
//   • моста Telegram → прежней CRM (flushOutbox, pollWatched) — он весь был завязан
//     на адреса адреса прежней системы;
//   • закрытия зависших по тишине — у CRM свой автозакрыватель и свои
//     правила, дублировать его значит спорить с системой оценки.

(() => {
  'use strict';
  if (window.__cmpAssist) return;
  window.__cmpAssist = true;

  // ---------- селекторы ----------

  const S = {
    // навигация
    projectBtns: '.project-switcher button',
    folders: '.inbox-folder',
    mineFilter: 'button.mine-filter',
    modeIndicator: '.mode-indicator',
    navInbox: '.top-nav-button[aria-label="Обращения"]',

    // список обращений
    convItem: 'button.conversation-item',
    convName: '.conversation-top strong',
    convDeadline: '.conversation-top .deadline',
    convProject: 'small.muted',
    convTopic: 'h3',
    convPreview: 'p',
    convBadge: '.conversation-bottom .badge',
    convId: '.conversation-bottom .ticket-id',
    convWeight: '.conversation-bottom .weight',
    listFooter: '.list-footer',

    // открытый диалог
    chatPane: '.chat-pane',
    chatHistory: '.chat-history',
    msgRow: '.message-row',
    msgMeta: '.message-meta',
    msgBubble: '.message-bubble',
    msgFoot: '.message-foot',
    sysEvent: '.system-event',
    histDate: '.history-date',
    // Полоса этапа живёт то в панели диалога, то в карточке клиента —
    // за четыре дня CRM успела её переставить. Поэтому ищем по классу
    // без привязки к родителю, но обязательно внутри открытого обращения:
    // в списке у каждой строки свой .deadline, и без этой оговорки бот
    // читал бы срок случайного чужого обращения.
    stageStrip: '.chat-pane .stage-strip, .client-pane .stage-strip',
    deadline: '.deadline',
    backBtn: 'button[aria-label="Назад к списку"]',

    // композер
    composer: '.composer',
    actionBtns: '.composer-actions button.message-action',
    textarea: 'textarea[aria-label="Текст ответа"]',
    sendBtn: '.composer-send-tools button.primary',

    // карточка клиента
    clientPane: '.client-pane',
    clientFields: '.client-fields',
    clientIdentity: '.client-identity',
    vpnEntry: '.vpn-entry button',
  };

  // Подписи кнопок «После отправки». Ровно те, что в CRM.
  const ACT = {
    none:     'Без действия',
    reply:    'Ответить и ждать',
    review:   'Я проверяю',
    engineer: 'Передать инженеру',
    close:    'Решено · закрыть',
    noreply:  'Ответ не требуется',
    night:    'Передать на утро',
  };

  // Что боту разрешено ставить. «Без действия» не останавливает таймер,
  // «Я проверяю» обещает проверку, которой бот не делает, и через 12/24
  // минуты превращается в персональную просрочку. Оба запрещены.
  const ALLOWED_ACTIONS = new Set([ACT.reply, ACT.engineer, ACT.close, ACT.noreply, ACT.night]);

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  const txt = (el) => ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();

  // «1 обращение», «2 обращения», «5 обращений» — строки автопилота читают
  // весь день, и кривое окончание в них мозолит глаза.
  const plural = (n, one, few, many) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    return b === 1 ? one : many;
  };

  const send = (type, payload) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      r?.ok ? resolve(r.data) : reject(new Error(r?.error || 'нет ответа'));
    });
  });

  // ---------- чтение открытого диалога ----------

  // Номер обращения — единственный устойчивый идентификатор. В карточке он
  // лежит строкой «Обращение #123», в списке — в .ticket-id.
  function ticketId() {
    const fields = readCard();
    if (fields['Обращение']) return String(fields['Обращение']).replace(/^#/, '');
    const sel = document.querySelector('.conversation-item.selected ' + S.convId);
    if (sel) return txt(sel).replace(/^#/, '');
    // Запасной путь: в прежней вёрстке номер стоял подписью под шапкой
    // («Обращение #123 · Взял в обработку: Имя»). Оставлено на случай,
    // если CRM вернёт его туда — за четыре дня она уже двигала полосу этапа.
    const head = document.querySelector(S.chatPane);
    const m = head && (head.innerText || '').match(/Обращение\s*#?(\d+)/);
    return m ? m[1] : null;
  }

  // Карточка клиента: пары «подпись → значение».
  function readCard() {
    const out = {};
    const box = document.querySelector(S.clientFields);
    if (!box) return out;
    for (const row of box.children) {
      const k = txt(row.querySelector('span'));
      const v = txt(row.querySelector('strong') || row.querySelector('.badge'));
      if (k) out[k] = v;
    }
    return out;
  }

  function clientName() {
    const h = document.querySelector(S.clientIdentity + ' h3');
    return h ? txt(h) : null;
  }

  // Канал наконец читается: «tg_business · <id>». В прежней CRM он не
  // определялся вообще — 2008 записей «не распознан» из 2009 за смену.
  function channel() {
    const c = readCard();
    if (c['Канал']) return c['Канал'];
    const sub = document.querySelector(S.clientIdentity + ' span');
    const m = txt(sub).match(/^([a-z_]+)\s*·/i);
    return m ? m[1] : null;
  }

  // Проект открытого диалога. Бот работает только на своём.
  function dialogProject() {
    const p = document.querySelector(S.clientIdentity + ' p.muted');
    return p ? txt(p) : null;
  }

  // Этап: класс у .stage-strip (reply / waiting_client / review / engineer /
  // closed / night) плюс человеческая подпись рядом.
  function stage() {
    const el = document.querySelector(S.stageStrip);
    if (!el) return { key: null, label: null };
    const key = Array.from(el.classList).find((c) => c !== 'stage-strip') || null;
    const strong = el.querySelector('strong');
    return { key, label: strong ? txt(strong) : null };
  }

  // Остаток срока в секундах. В CRM он рисуется как «0:10», «+0:10»,
  // «Без таймера», «Ждём клиента». Плюс означает, что срок уже вышел.
  function deadlineSecs() {
    const strip = document.querySelector(S.stageStrip);
    const el = (strip && strip.querySelector(S.deadline))
      || document.querySelector('.chat-pane ' + S.deadline);
    if (!el) return null;
    const t = txt(el);
    // Минут может быть и три цифры: «+142:18» — это два с лишним часа
    // просрочки. Раньше в шаблоне стояло \d{1,2}, и от такого таймера
    // откусывалось начало: «+142:18» читалось как «42:18 до срока», то есть
    // просроченное обращение выглядело запасом в сорок минут, и бот вставал
    // на долгую паузу вместо немедленного ответа.
    const m = t.match(/([+-]?)(\d+):(\d{2})/);
    if (!m) return null;                       // «Без таймера», «Ждём клиента»
    const secs = Number(m[2]) * 60 + Number(m[3]);
    return m[1] === '+' ? -secs : secs;        // «+» = просрочка, отдаём минусом
  }

  // Множитель режима нагрузки: ×1 / ×2 / ×4 из шапки.
  function loadMultiplier() {
    const el = document.querySelector(S.modeIndicator);
    if (!el) return 1;
    const m = txt(el).match(/×\s*(\d)/);
    return m ? Number(m[1]) : 1;
  }


  // Строка переписки → кто её написал.
  //   incoming            — клиент
  //   outgoing            — оператор (имя в .message-meta)
  //   outgoing automated  — автоответ CRM (ночной и напоминания)
  function rowKind(row) {
    const c = row.classList;
    if (c.contains('incoming')) return 'client';
    if (c.contains('automated')) return 'auto';
    if (c.contains('outgoing')) return 'operator';
    return 'other';
  }

  // Текст реплики. Пустой текст — ещё не пустая реплика: чаще всего это
  // скриншот без подписи, и для разбора он значит ровно то же, что слова.
  //
  // однажды здесь стоял свой, более узкий список селекторов, чем в
  // rowHasAttachment. После редизайна он перестал совпадать, реплика со
  // скриншотом читалась как пустая, и одно обращение, одно обращение, одно обращение
  // пропускались с «этап "Нужен ответ", но последним стоит сотрудник».
  // Теперь признак вложения один на весь файл.
  function rowText(row) {
    const b = row.querySelector(S.msgBubble);
    const t = b ? (b.innerText || '').trim() : '';
    if (t) return t;
    return rowHasAttachment(row) ? '[вложение]' : '';
  }

  function rowTime(row) {
    const t = row.querySelector(S.msgFoot + ' time');
    return t ? txt(t) : '';
  }

  // Действие, с которым ушла реплика оператора: в .message-foot первым
  // span-ом лежит «Ответить и ждать», «Решено · закрыть» и т.п.
  function rowAction(row) {
    const foot = row.querySelector(S.msgFoot);
    if (!foot) return '';
    const first = foot.querySelector('span:not(.delivery)');
    const v = txt(first);
    return Object.values(ACT).includes(v) ? v : '';
  }

  function rowDelivery(row) {
    const d = row.querySelector('.delivery');
    if (!d) return '';
    if (d.classList.contains('failed')) return 'failed';
    if (d.classList.contains('delivered')) return 'delivered';
    return 'unknown';
  }

  function messageRows() {
    const box = document.querySelector(S.chatHistory);
    return box ? Array.from(box.querySelectorAll(S.msgRow)) : [];
  }

  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  // Переписка текстом для модели. Формат тот же, что был в прежней CRM, — промпт
  // и сторожа в background.js разбирают его без изменений.
  // Имя оператора нужно прямо в разметке переписки, а читать настройки там
  // негде — history() синхронный. Держим копию: её обновляет разбор
  // обращения, который настройки и так читает.
  let MY_NAME = '';
  chrome.storage.local.get(['myName']).then((s) => { MY_NAME = s.myName || ''; }).catch(() => {});

  // Лента целиком, а не последние четырнадцать реплик.
  //
  // Урезание до 14 и было половиной жалоб «не видит контекста»: клиент
  // описывает проблему в начале, десять сообщений уточняет, и к моменту
  // ответа начало уже за краем окна. Ограничение теперь по объёму, а не по
  // числу реплик, и режется начало — свежее важнее.
  function history(limitChars = 24000) {
    const now = new Date();
    const head = `Сейчас: ${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}, `
      + `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const card = readCard();
    const st = stage();
    const meta = [
      card['Обращение'] ? `Обращение ${card['Обращение']}` : null,
      st.label ? `этап: ${st.label}` : null,
      card['Ответственный'] ? `ответственный: ${card['Ответственный']}` : null,
      card['Канал'] ? `канал: ${card['Канал']}` : null,
      card['Первое обращение'] ? `первое обращение: ${card['Первое обращение']}` : null,
    ].filter(Boolean).join(' · ');

    const box = document.querySelector(S.chatHistory);
    const lines = [];
    if (box) {
      // Идём по ленте подряд, чтобы разделители дат встали на свои места:
      // без них модель принимает сообщение недельной давности за свежее.
      const nodes = Array.from(box.children);
      for (const n of nodes) {
        if (n.classList.contains('history-date')) { lines.push(`--- ${txt(n)} ---`); continue; }
        if (n.classList.contains('system-event')) { lines.push(`[событие] ${txt(n)}`); continue; }
        if (!n.classList.contains('message-row')) continue;
        const kind = rowKind(n);
        const t = rowText(n);
        if (!t) continue;
        const when = rowTime(n);
        if (kind === 'client') {
          lines.push(`[${when}] КЛИЕНТ: ${t}`);
        } else if (kind === 'auto') {
          lines.push(`[${when}] АВТООТВЕТ CRM (это не сотрудник; клиент ответа не получил от человека): ${t}`);
        } else {
          // Своя реплика и реплика коллеги — разные вещи. Свою можно
          // продолжать, чужую нельзя переигрывать: диагностику коллеги надо
          // принять как данность, а не начинать заново.
          const who = txt(n.querySelector(S.msgMeta)) || '';
          const mine = MY_NAME && normName(who) === normName(MY_NAME);
          const tag = who
            ? `ОПЕРАТОР ${who}${mine ? ' (это вы)' : ' (другой оператор)'}`
            : 'ОПЕРАТОР';
          const act = rowAction(n);
          lines.push(`[${when}] ${tag}${act ? ` (действие: ${act})` : ''}: ${t}`);
        }
      }
    }

    // Короткий итог по ленте — то, что модель раз за разом читала неверно:
    // отвечал ли клиенту вообще живой человек и сколько он ждёт.
    const rows = messageRows();
    let after = 0;
    let lastOp = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const k = rowKind(rows[i]);
      if (k === 'client') { after++; continue; }
      if (k === 'operator') { lastOp = rows[i]; break; }
    }
    const tailNote = lastOp
      ? `[итог] после последнего ответа сотрудника (${rowTime(lastOp) || '?'}) клиент написал ${after} реплик`
      : '[итог] сотрудник в этом обращении ещё не отвечал — клиент ждёт первого ответа';

    // Режем начало: если переписка длинная, свежие реплики важнее старых.
    let body = lines.join('\n');
    if (body.length > limitChars) {
      body = '[начало переписки не поместилось]\n' + body.slice(-limitChars);
    }
    return [head, meta, '', body, '', tailNote].join('\n');
  }

  // Лента переписки подгружается по мере прокрутки: при открытии обращения
  // в DOM попадает не вся история, а её видимая часть. Если диалог длинный,
  // свежие реплики оказываются ниже отрисованного — и бот видит только старые.
  //
  // Отсюда и брались пропуски «клиент не писал последним» на обращениях,
  // где клиент только что ответил.
  //
  // Крутим до низа и ждём, пока число реплик перестанет расти.
  async function scrollHistoryToEnd(maxTries = 14) {
    const box = document.querySelector(S.chatHistory);
    if (!box) return 0;
    let prev = -1;
    for (let i = 0; i < maxTries; i++) {
      const n = messageRows().length;
      box.scrollTop = box.scrollHeight;
      await wait(260);
      const after = messageRows().length;
      if (after === n && n === prev) return n;   // два замера подряд без роста
      prev = n;
    }
    return messageRows().length;
  }

  // Что говорит сама CRM. Это надёжнее разбора ленты: её состояние считает
  // сервер, а не мы по отрисованным строкам.
  //   reply          — «Нужен ответ», клиент ждёт
  //   waiting_client — ждём клиента
  //   closed         — закрыто
  // Если этап говорит «нужен ответ», а в ленте последним стоит сотрудник,
  // значит лента дочитана не до конца.
  function crmWantsAnswer() {
    const k = stage().key;
    if (!k) return null;                 // полосы этапа нет — судить не по чему
    return k === 'reply';
  }

  // Последняя реплика клиента, если отвечать вообще надо.
  //
  // Автоответ CRM ответом сотрудника не считается — это прямая формулировка
  // главы 04. Поэтому он прозрачен: идём сквозь него дальше.
  //
  // Из этого сами собой получаются оба нужных случая:
  //
  //   клиент → автоответ ночной поддержки        → отвечаем утром клиенту,
  //                                                автоответ не «закрыл» вопрос;
  //   оператор → тишина → напоминание через 30 мин → не отвечаем: напоминание
  //                                                шлют клиенту, ждут его.
  //
  // Разбирать «ночной автоответ или напоминание» отдельно не нужно: порядок
  // реплик отвечает на вопрос сам.
  // Берём не одну последнюю строку, а всю пачку подряд идущих реплик клиента
  // после последнего сотрудника. Клиент почти никогда не пишет одним
  // сообщением: «Доброе утро, нет подключения» и два скриншота — это три
  // строки в ленте и один вопрос по сути. Раньше бот видел только последнюю
  // из них, а если последней был скриншот без подписи — не видел ничего.
  function lastFromClient() {
    const rows = messageRows();
    const mine = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const k = rowKind(rows[i]);
      if (k === 'client') { mine.unshift(rows[i]); continue; }
      if (k === 'operator') break;             // дальше писал живой сотрудник
      // 'auto' и прочее — прозрачны, смотрим глубже
    }
    if (!mine.length) return null;
    // Хвоста хватает: если клиент написал два десятка реплик подряд, разбирать
    // надо последние, а вся лента и так уходит модели отдельно.
    const parts = mine.slice(-6).map(rowText).filter(Boolean);
    return parts.join('\n') || null;
  }

  // Сколько минут назад отправлена реплика. Время в ленте московское, как и
  // всё в CRM, поэтому сравниваем с московскими часами.
  function minutesAgo(row) {
    const m = rowTime(row).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    let diff = mskNow() - (Number(m[1]) * 60 + Number(m[2]));
    if (diff < 0) diff += 1440;          // реплика со вчерашнего дня
    return diff;
  }

  function lastOperatorRow() {
    const rows = messageRows();
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rowKind(rows[i]) === 'operator') return rows[i];
    }
    return null;
  }

  function anyClientImage() {
    return messageRows().some((r) => rowKind(r) === 'client' && rowHasAttachment(r));
  }

  // Что уже сделали операторы в этом обращении. В прежней CRM это читалось из вывода
  // админ-бота; здесь — из текста исходящих реплик.
  const DID = [
    [/ключ отправ|отправил вам ключ|высла[лн] ключ/i, 'ключ уже отправлен клиенту'],
    [/перевыпущ|пересозда/i,                          'ключ уже пересоздавали'],
    [/перезагруз/i,                                   'перезагрузку уже просили'],
    [/переустанов/i,                                  'переустановку уже просили'],
    [/скриншот|снимок экрана/i,                       'скриншот уже просили'],
    [/сменил[аи]? тариф|тариф изменён|тариф изменен/i, 'тариф уже меняли'],
    [/баланс пополнен|пополнил[аи]? баланс/i,         'баланс уже пополняли'],
  ];

  function operatorDid() {
    const out = [];
    for (const r of messageRows()) {
      if (rowKind(r) !== 'operator') continue;
      const t = rowText(r);
      for (const [re, label] of DID) {
        if (re.test(t) && !out.includes(label)) out.push(label);
      }
    }
    return out;
  }

  // ---------- кабинет VPN ----------
  //
  // В прежней CRM баланс, тариф и списание висели в правой панели и читались
  // бесплатно, обычным разбором DOM. В CRM они спрятаны за кнопкой
  // «Управление VPN», и панель грузится до минуты — она сама об этом пишет.
  //
  // Минута дорога: норматив первого ответа 3/6 минут. Поэтому кабинет
  // открывается не для каждого обращения, а только когда ответ без него
  // не собирается: background возвращает action 'needAccount', и мы идём
  // за данными уже адресно.
  //
  // Панель только читает. Менять тариф, ключ или страну из неё нельзя —
  // «Изменения выполняет администратор». Поэтому команд выдачи ключа у бота
  // нет и не будет, пока это так: он может только объяснить клиенту, что
  // сделать самому.

  const VPN_LABELS = {
    'ID кабинета': 'cabinetId',
    'Имя устройства': 'deviceName',
    'Баланс': 'balance',
    'Списание в день': 'daily',
    'Тариф': 'tariff',
    'Страна': 'country',
    'Ядро': 'core',
    'IP сервера': 'serverIp',
    'VPN': 'vpnState',
    'Telegram-бот': 'tgState',
  };

  // Ищем панель по содержимому, а не по классу: классов этой панели я
  // не видел, а подписи полей — видел. Содержимое переживёт рестайл.
  function vpnPanelEl() {
    const nodes = Array.from(document.querySelectorAll('div, aside, section'));
    for (let i = nodes.length - 1; i >= 0; i--) {
      const t = nodes[i].innerText || '';
      if (t.includes('ID кабинета') && t.includes('Баланс') && t.length < 4000) return nodes[i];
    }
    // Панель ещё грузится — вернём её же, чтобы отличать «нет панели»
    // от «панель есть, но пустая».
    return nodes.find((n) => (n.innerText || '').includes('VPN · клиент')) || null;
  }

  // Панель — сетка из двух колонок, и порядок обхода зависит от того, как
  // она свёрстана. Возможны оба варианта, и угадывать нельзя:
  //
  //   по ячейкам:  Баланс · 25.6 ₽ · Списание в день · 4.5 ₽
  //   построчно:   Баланс · Списание в день · 25.6 ₽ · 4.5 ₽
  //
  // Поэтому не берём «следующую строку», а находим подряд идущую группу
  // подписей длиной k и сопоставляем ей следующие k строк по порядку.
  // При k = 1 это старое поведение, при k = 2 — построчная сетка.
  function parseVpnPanel(root) {
    if (!root) return null;
    const lines = (root.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const out = {};

    let i = 0;
    while (i < lines.length) {
      if (!VPN_LABELS[lines[i]]) { i++; continue; }
      const group = [];
      while (i < lines.length && VPN_LABELS[lines[i]]) { group.push(lines[i]); i++; }
      for (let j = 0; j < group.length; j++) {
        const v = lines[i + j];
        if (v === undefined || VPN_LABELS[v]) break;
        const key = VPN_LABELS[group[j]];
        if (out[key] === undefined) out[key] = v;
      }
      i += group.length;
    }

    // Последняя страховка: если подписи не сошлись, берём суммы в рублях
    // по порядку — баланс в панели всегда стоит раньше списания.
    if (out.balance === undefined || out.daily === undefined) {
      const rub = (root.innerText || '').match(/-?\d[\d\s]*[.,]?\d*\s*₽/g) || [];
      if (out.balance === undefined && rub[0]) out.balance = rub[0];
      if (out.daily === undefined && rub[1]) out.daily = rub[1];
    }

    if (out.balance === undefined && out.tariff === undefined) return null;

    // Числа приводим к виду, который ждёт подстановка в базе знаний.
    // Пробелы в тысячах убираем до разбора: «1 250,75 ₽» иначе читается
    // как 1 рубль, и клиент с полутора тысячами на счету получает ответ
    // для пустого баланса.
    const num = (v) => {
      if (v === undefined) return null;
      const m = String(v).replace(/\s/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
      return m ? parseFloat(m[0]) : null;
    };
    return {
      balance: num(out.balance),
      daily: num(out.daily),
      tariff: out.tariff || null,
      country: out.country || null,
      core: out.core || null,
      serverIp: out.serverIp || null,
      vpnState: out.vpnState || null,
      cabinetId: out.cabinetId || null,
      deviceName: out.deviceName || null,
    };
  }

  async function closeVpnPanel() {
    const root = vpnPanelEl();
    const btn = root && Array.from(root.querySelectorAll('button'))
      .find((b) => /закрыть/i.test(b.getAttribute('aria-label') || '') || txt(b) === '');
    if (btn) { btn.click(); await wait(400); }
    if (vpnPanelEl()) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(400);
    }
  }

  // Возвращает { balance, daily, tariff, ... } или null.
  async function readVpnPanel() {
    const { vpnTimeout = '' } = await chrome.storage.local.get(['vpnTimeout']);
    const limitMs = (Number(vpnTimeout) > 0 ? Number(vpnTimeout) : 75) * 1000;

    const open = document.querySelector(S.vpnEntry);
    if (!open) { log('кнопка «Управление VPN» не найдена', 'err'); return null; }

    open.click();
    const t0 = Date.now();
    let said = false;

    while (Date.now() - t0 < limitMs) {
      if (state.abort && state.running) {
        await closeVpnPanel();
        throw Object.assign(new Error('остановлено оператором'), { aborted: true });
      }
      const root = vpnPanelEl();
      const txtAll = root ? (root.innerText || '') : '';
      if (root && !/Выполняю запрос/i.test(txtAll)) {
        const parsed = parseVpnPanel(root);
        if (parsed) {
          await closeVpnPanel();
          log(`<span class="ja-dim">кабинет: баланс ${parsed.balance ?? '—'} ₽ · тариф ${parsed.tariff || '—'} · ${Math.round((Date.now() - t0) / 1000)}с</span>`);
          return parsed;
        }
      }
      if (!said && Date.now() - t0 > 8000) { said = true; log('<span class="ja-dim">жду кабинет VPN…</span>'); }
      await wait(1200);
    }

    await closeVpnPanel();
    log(`кабинет VPN не загрузился за ${Math.round(limitMs / 1000)}с`, 'err');
    return null;
  }

  // Картинка клиента для модели. Вложения CRM отдаёт прямыми ссылками,
  // качаем через background (в контент-скрипте нет нужных прав на CORS).
  // Ссылки на вложение в одной реплике, в порядке предпочтения.
  //
  // CRM проксирует вложения через себя: /api/messages/<id>/attachments/0/content.
  // Этот путь и берём — он на своём домене, работает по сессии оператора
  // и не требует никаких токенов.
  //
  // Рядом в разметке лежит прямая ссылка Telegram вида
  // api.telegram.org/file/bot<ТОКЕН>/... — её не трогаем НИКОГДА. В ней
  // открытым текстом токен рабочего бота: любой, кто откроет карточку,
  // получает управление им. Мы этот токен не читаем, не сохраняем и не
  // отправляем; передайте владельцам, что его пора отозвать, а файлы
  // раздавать только через свой прокси.
  function attachmentUrls(row) {
    const out = [];
    for (const a of row.querySelectorAll('a[href]')) {
      const h = a.href || '';
      if (/api\.telegram\.org/i.test(h)) continue;
      if (/\/attachments\/\d+\/content/i.test(h)) out.push(h);
    }
    for (const img of row.querySelectorAll('img[src]')) {
      const s = img.src || '';
      if (/api\.telegram\.org/i.test(s)) continue;
      if (/^https?:|^blob:/i.test(s)) out.push(s);
    }
    return [...new Set(out)];
  }

  // Есть ли в реплике вложение вообще — отдельно от того, удалось ли его
  // прочитать. Разница важна: бот должен знать, что картинка была, даже
  // если не смог её открыть.
  function rowHasAttachment(row) {
    // Картинки ищем внутри пузыря и по СВОЙСТВУ src, а не по атрибуту.
    // Селектор img[src^="http"] сверяет атрибут как он написан в разметке:
    // пока CRM подставляла полный адрес, он совпадал, а после редизайна
    // путь стал относительным (/api/messages/...) — и совпадать перестал.
    // Свойство .src браузер разворачивает в полный адрес всегда.
    //
    // Смотрим в пузырь, а не во всю строку: в строке есть ещё аватар
    // отправителя, и по нему вложение нашлось бы в каждой реплике.
    const box = row.querySelector(S.msgBubble) || row;
    for (const img of box.querySelectorAll('img')) {
      const s = img.getAttribute('src') || '';
      if (!s) continue;
      if (/^data:image\/svg/i.test(s)) continue;     // значки интерфейса
      return true;
    }
    if (box.querySelector('video, audio, a[download], a[href*="attachment"], a.attachment-link, [class*="attach" i]')) return true;
    if (row.querySelector('a[href*="/attachments/"]')) return true;
    return /Не удалось загрузить изображение|\.(jpg|jpeg|png|heic|webp|pdf|mp4|zip)\b/i.test(row.innerText || '');
  }

  // Результат: { image, had, failed }.
  //   had    — клиент присылал вложение
  //   failed — присылал, но открыть не удалось (сейчас это 504 у самой CRM)
  async function grabLastImage(maxSide = 1400) {
    const rows = messageRows().filter((r) => rowKind(r) === 'client');
    let had = false;

    for (let i = rows.length - 1; i >= 0; i--) {
      if (!rowHasAttachment(rows[i])) continue;
      had = true;
      for (const url of attachmentUrls(rows[i])) {
        try {
          // Свой домен — тянем прямо отсюда, с кукой сессии. Через background
          // идём только для чужих хостов.
          let blob = null;
          if (url.startsWith(location.origin) || url.startsWith('blob:')) {
            const r = await fetch(url, { credentials: 'include' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            blob = await r.blob();
          } else {
            const got = await send('fetchImage', { url });
            if (!got || !got.data) throw new Error('пусто');
            blob = await (await fetch(`data:${got.mime};base64,${got.data}`)).blob();
          }
          if (!/^image\//.test(blob.type || '')) throw new Error(`не картинка (${blob.type || '?'})`);

          const bmp = await createImageBitmap(blob);
          const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
          const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
          const cv = new OffscreenCanvas(w, h);
          cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
          const out = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
          const buf = new Uint8Array(await out.arrayBuffer());
          let bin = '';
          for (const b of buf) bin += String.fromCharCode(b);
          // media_type, а не mime: под этим именем поле читают обе ветки
          // background.js. С mime собирался адрес «data:undefined;base64,…»,
          // и DeepInfra отвечала 422 «content should be a valid string».
          // Ошибка тянется ещё из версии для прежней CRM — там она просто была не видна.
          return { image: { media_type: 'image/jpeg', mime: 'image/jpeg', data: btoa(bin), w, h },
                   had: true, failed: false };
        } catch (e) {
          log(`<span class="ja-dim">вложение не открылось: ${String(e.message || e).slice(0, 60)}</span>`);
        }
      }
      break;   // разбираем только последнее вложение клиента
    }
    return { image: null, had, failed: had };
  }

  // Честная приписка к переписке. Без неё модель видит в ленте «[вложение]»
  // и отвечает так, будто скриншот у неё перед глазами: описывает несуществующую
  // ошибку, ссылается на «то, что на снимке». Клиент читает это как издевательство.
  //
  // Сейчас сюда попадает почти каждое вложение: CRM отдаёт 504 на собственном
  // /api/messages/<id>/attachments/0/content.
  function shotNote(shot) {
    if (!shot || !shot.had) return '';
    if (!shot.failed) return '';
    return '\n\nПРИМЕЧАНИЕ ДЛЯ ТЕБЯ (клиент этого не писал): клиент прислал изображение,'
      + ' но открыть его не удалось — сбой на стороне CRM. Ты НЕ видишь этот снимок.'
      + ' Не описывай, что на нём, не ссылайся на него и не делай вид, что посмотрел.'
      + ' Если для ответа нужно содержимое снимка — спроси словами, что именно на нём,'
      + ' либо действуй по тексту обращения.';
  }

  // ---------- запись ----------

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Поле ввода в React: присвоение el.value интерфейс не заметит, текст
  // окажется в DOM, а отправится пустота. Поэтому только нативный сеттер.
  async function putText(text) {
    let el = document.querySelector(S.textarea);
    for (let i = 0; i < 12 && !el; i++) { await wait(300); el = document.querySelector(S.textarea); }
    if (!el) throw Object.assign(new Error('поле ответа не найдено'), { taken: true });
    if (!visible(el)) throw Object.assign(new Error('поле ответа скрыто'), { taken: true });
    el.scrollIntoView({ block: 'center' });
    await wait(120);
    el.focus();
    setNativeValue(el, text);
    await wait(150);
    if ((el.value || '').trim() !== String(text || '').trim()) {
      throw new Error('текст не встал в поле ответа');
    }
    return el;
  }

  // Выбор действия «После отправки» с проверкой, что оно реально выбралось:
  // aria-pressed переключает сам интерфейс, а не наш клик.
  // Подпись кнопки действия без служебной шелухи.
  //
  // однажды CRM пронумеровала кнопки: было «Ответить и ждать», стало
  // «1 Ответить и ждать». Точное сравнение перестало совпадать, и бот падал
  // бы на каждой отправке. Заодно поменялся порядок: «Без действия» уехало
  // с первого места на шестое — на код это не влияет, мы ищем по смыслу.
  //
  // Поэтому срезаем ведущий номер и нормализуем пробелы: следующая
  // перестановка или новая нумерация уже ничего не сломает.
  const normAction = (t) => String(t || '')
    .replace(/^\s*\d+\s*[.)]?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Кнопки действий. Основной путь — класс, запасной — поиск по подписям
  // внутри композера: класс переживёт не всякий их релиз, а названия
  // действий завязаны на инструкцию и меняются реже.
  function actionButtons() {
    let btns = Array.from(document.querySelectorAll(S.actionBtns));
    if (btns.length) return btns;
    const box = document.querySelector(S.composer);
    if (!box) return [];
    const known = new Set(Object.values(ACT));
    return Array.from(box.querySelectorAll('button')).filter((b) => known.has(normAction(txt(b))));
  }

  async function pickAction(label) {
    if (!ALLOWED_ACTIONS.has(label)) throw new Error(`действие «${label}» боту запрещено`);
    const btns = actionButtons();
    if (!btns.length) throw new Error('кнопки действий не найдены — разметка CRM изменилась');
    const btn = btns.find((b) => normAction(txt(b)) === label);
    if (!btn) {
      const have = btns.map((b) => normAction(txt(b))).join(' | ');
      throw new Error(`кнопка «${label}» не найдена. Есть: ${have}`);
    }
    for (let i = 0; i < 4; i++) {
      btn.click();
      await wait(250);
      if (btn.getAttribute('aria-pressed') === 'true') return true;
    }
    // Разметка могла перестать помечать выбранное через aria-pressed.
    // Считаем выбранным, если кнопка визуально выделилась.
    if (/\b(active|selected|is-active|checked)\b/.test(btn.className || '')) return true;
    throw new Error(`действие «${label}» не выбралось`);
  }

  // Какие действия CRM предлагает прямо сейчас.
  function availableActions() {
    return new Set(actionButtons().map((b) => normAction(txt(b))));
  }

  // «Ответ не требуется» однажды пропало из набора: на экране осталось
  // шесть кнопок вместо семи. Возможно, его показывают только на закрытых
  // обращениях, возможно — убрали совсем.
  //
  // Падать из-за этого нельзя: закрыть обращение на «спасибо» надо в любом
  // случае. Если кнопки нет — берём «Решено · закрыть». Смысл близкий,
  // а обращение не повиснет до просрочки.
  function closeAction() {
    const have = availableActions();
    if (have.has(ACT.noreply)) return ACT.noreply;
    if (have.has(ACT.close)) {
      log('<span class="ja-dim">«Ответ не требуется» нет в наборе — закрываю через «Решено · закрыть»</span>');
      return ACT.close;
    }
    return ACT.noreply;   // пусть pickAction скажет, чего не хватает
  }

  // Переписка могла измениться, пока бот думал и держал паузу.
  //
  // однажды в прежней CRM бот прочитал диалог, где последним висело сообщение
  // семнадцатиминутной давности, ушёл на модель и паузу, а за это время
  // коллега подобрал диалог, ответил и начал выводить клиенту деньги. Бот
  // отправил ответ по устаревшей картине, поверх живого разговора.
  //
  // Сторож чужого оператора это не ловит: на момент проверки коллеги
  // в диалоге ещё не было. Поэтому сверяемся ещё раз перед самой отправкой.
  // Стоит ноль: чистый DOM, к модели не обращаемся.
  // Причина возвращается объектом: вызывающему важно не только ЧТО случилось,
  // но и можно ли попробовать ещё раз. Клиент дописал сообщение — можно и
  // нужно: он не виноват, что печатает медленнее, чем мы думаем. Ответил
  // коллега — нельзя, диалог больше не наш.
  function staleReason(seenLast, mine) {
    if (lastFromClient() !== seenLast) {
      return { text: 'клиент дописал, пока готовился ответ', retry: true };
    }
    const lo = lastOperatorRow();
    if (!lo || !mine) return null;
    const who = normName(txt(lo.querySelector(S.msgMeta)));
    const mins = minutesAgo(lo);
    if (who && who !== mine && (mins === null || mins < 15)) {
      return { text: `${who} ответил, пока готовился ответ`, retry: false };
    }
    return null;
  }

  // Отправка с подтверждением доставки. По правилам CRM «текст появился
  // в ленте» ответом не считается: смотрим на .delivery у новой строки.
  // При failed повтор запрещён — клиент получит дубликат.
  async function sendReply(text, action) {
    // Флаг остановки относится к прогону автопилота. Если прогон уже не идёт,
    // а оператор жмёт кнопку руками — это новое решение, не продолжение
    // остановленного.
    if (state.abort && state.running) {
      throw Object.assign(new Error('остановлено оператором'), { aborted: true });
    }

    const before = messageRows().length;
    if (String(text || '').trim()) await putText(text);
    else {
      // «Ответ не требуется» разрешает пустое поле: CRM запишет решение
      // в историю, а клиенту ничего не уйдёт.
      const el = document.querySelector(S.textarea);
      if (el && (el.value || '').trim()) setNativeValue(el, '');
    }
    await pickAction(action);
    await wait(150);

    const btn = document.querySelector(S.sendBtn);
    if (!btn) throw new Error('кнопка «Отправить» не найдена');

    // CRM спрашивает подтверждение нативным confirm() на «Ответ не требуется»
    // и «Решено · закрыть». Нативный диалог останавливает весь JavaScript
    // страницы и ждёт человека — из-за этого встала вся очередь,
    // пока оператора не было на месте.
    //
    // Метка говорит page-hook.js (он живёт в контексте страницы), что диалог
    // вызвал бот и его надо подтвердить. Снимаем сразу после: подтверждения
    // на кнопки, нажатые руками, должны спрашивать как обычно.
    document.documentElement.setAttribute('data-cmp-auto', '1');
    try {
      btn.click();
      await wait(250);           // confirm успевает открыться и закрыться
    } finally {
      document.documentElement.removeAttribute('data-cmp-auto');
    }

    // Сколько ждать CRM. Раньше стояло намертво: 9,6 секунды на появление
    // строки и 9 секунд на отметку доставки. однажды из 101 отправки
    // 20 ушли с «доставка неизвестна», а 7 упали с «отправка не
    // подтвердилась» — CRM просто не успевала. Ждём дольше и с запасом;
    // на быстрой отправке это ничего не стоит, выходим по первой же отметке.
    const { sendWait = '' } = await chrome.storage.local.get(['sendWait']);
    const waitSec = Math.max(10, Number(sendWait) || 30);
    const rowTries = Math.ceil((waitSec * 1000) / 400);
    const deliveryTries = Math.ceil((waitSec * 1000) / 600);

    for (let i = 0; i < rowTries; i++) {
      await wait(400);
      const rows = messageRows();
      if (rows.length > before) {
        const last = rows[rows.length - 1];
        if (rowKind(last) !== 'client') {
          // Ждём, пока подтвердится доставка: сразу после клика метки ещё нет.
          for (let j = 0; j < deliveryTries; j++) {
            const d = rowDelivery(last);
            if (d === 'delivered') return { ok: true, delivery: d };
            if (d === 'failed') return { ok: false, delivery: d };
            await wait(600);
          }
          // Строка в ленте есть — значит ответ ушёл. Отметки нет: CRM её
          // ставит асинхронно и иногда не успевает. Повторять отправку
          // нельзя ни в коем случае — уйдёт дубликат.
          return { ok: true, delivery: 'unknown' };
        }
      }
      // Пустой текст при «Ответ не требуется» новой строки не создаёт —
      // судим по тому, что этап сменился на «Закрыто».
      if (!String(text || '').trim() && stage().key === 'closed') {
        return { ok: true, delivery: 'no-message' };
      }
    }
    throw new Error('отправка не подтвердилась');
  }

  // ---------- навигация ----------

  async function selectProject(name) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return true;
    const btns = Array.from(document.querySelectorAll(S.projectBtns));
    const b = btns.find((x) => txt(x).toLowerCase().startsWith(want));
    if (!b) return false;
    if (b.getAttribute('aria-pressed') === 'true') return true;
    b.click();
    await wait(1200);
    return b.getAttribute('aria-pressed') === 'true';
  }

  function currentProject() {
    const b = Array.from(document.querySelectorAll(S.projectBtns))
      .find((x) => x.getAttribute('aria-pressed') === 'true');
    return b ? txt(b).replace(/\s*\d+\s*$/, '').trim() : null;
  }

  // Сверять подпись папки буквально нельзя: в ней живёт счётчик, и CRM то
  // кладёт его в aria-label («Входящие вам, 1»), то нет. Срезаем хвост из
  // цифр и сравниваем без учёта регистра; если aria-label пропал совсем —
  // сверяем по видимому тексту вкладки.
  const folderKey = (s) => String(s || '')
    .replace(/[\s,·]*\d+(\s*\/\s*\d+)?\s*$/, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();

  function folderTab(label) {
    const tabs = Array.from(document.querySelectorAll(S.folders));
    const want = folderKey(label);
    return tabs.find((x) => folderKey(x.getAttribute('aria-label')) === want)
        || tabs.find((x) => folderKey(txt(x)) === want)
        || null;
  }

  // Переключение папки считается состоявшимся не по aria-current, а по самому
  // списку: атрибут CRM проставляет сразу, а строки подгружает запросом.
  // Раньше здесь стояло «подождать 1,1 секунды» — за это время список успевал
  // опустеть, но не успевал наполниться, и папка объявлялась разобранной.
  async function openFolder(label) {
    const b = folderTab(label);
    if (!b) return false;

    if (b.getAttribute('aria-current') === 'page') return true;

    // Список предыдущей папки остаётся на экране, пока CRM грузит новый.
    // Раньше бот ждал 1,1 секунды и читал этот остаток: все обращения в нём
    // он уже видел, поэтому объявлял папку разобранной и уходил дальше.
    // Со стороны это и выглядит как «читает, но не берёт».
    const before = listRows().map((r) => r.id).join(',');
    b.click();

    let prev = null;
    for (let i = 0; i < 16; i++) {          // до ~6,5 секунд
      await wait(400);
      const now = listRows().map((r) => r.id).join(',');
      // Список сменился и успокоился — папка точно наша.
      if (now !== before && now === prev) return true;
      prev = now;
    }
    // Не дождались смены. Бывает и законно: папка может совпадать по составу.
    // Возвращаем true, но выше это заметит сверка со счётчиком вкладки.
    return true;
  }

  function folderCount(label) {
    const b = folderTab(label);
    if (!b) return null;
    // Счётчик лежал в <small>; после редизайна он может быть просто текстом
    // рядом с названием. Берём первое число из подписи, где бы оно ни было.
    //
    // Нет цифр — это НЕ ноль, это «счётчик ещё не пришёл». Возвращаем null.
    // Раньше здесь стоял ноль, и пока CRM писала «Загружаю данные…», все
    // вкладки выглядели пустыми: бот честно докладывал «Просроченные: пусто»
    // при девяти просроченных на экране.
    const small = b.querySelector('small');
    const m = txt(small || b).match(/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  // Строки очереди. Лента «Общие» (article.feed-event) — это события команды,
  // а не очередь: там одно обращение встречается несколько раз. Работаем
  // только со списком обращений.
  function listRows() {
    return Array.from(document.querySelectorAll(S.convItem)).map((row) => ({
      row,
      id: txt(row.querySelector(S.convId)).replace(/^#/, ''),
      name: txt(row.querySelector(S.convName)),
      project: txt(row.querySelector(S.convProject)),
      topic: txt(row.querySelector(S.convTopic)),
      preview: txt(row.querySelector(S.convPreview)),
      badge: txt(row.querySelector(S.convBadge)),
      deadline: txt(row.querySelector(S.convDeadline)),
      weight: txt(row.querySelector(S.convWeight)),
    })).filter((r) => r.id);
  }

  async function openRow(id) {
    const r = listRows().find((x) => x.id === String(id));
    if (!r) return false;
    r.row.scrollIntoView({ block: 'center' });
    await wait(200);
    r.row.click();
    for (let i = 0; i < 20; i++) {
      await wait(300);
      if (document.querySelector(S.chatHistory) && ticketId() === String(id)) return true;
    }
    return false;
  }

  async function backToList() {
    const b = document.querySelector(S.backBtn);
    if (b && visible(b)) { b.click(); await wait(600); }
  }

  // ---------- рабочее окно смены ----------
  //
  // Правило CRM: в плановый конец смены выдача новых обращений прекращается,
  // а через час без действий смена закрывается сама. Бот, который продолжает
  // отвечать после закрытия смены, создаёт активность без подтверждённого
  // выхода — это прямое нарушение главы 05.
  //
  // Время московское, как и всё в CRM.
  function mskNow() {
    const s = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Moscow', hour12: false });
    const m = s.match(/(\d{2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : new Date().getHours() * 60;
  }

  function parseHM(v) {
    const m = String(v || '').match(/^(\d{1,2})[:.](\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  async function shiftWindow() {
    const { shiftFrom = '', shiftTo = '' } = await chrome.storage.local.get(['shiftFrom', 'shiftTo']);
    const a = parseHM(shiftFrom), b = parseHM(shiftTo);
    if (a === null || b === null) return { ok: true, note: '' };   // не задано — не ограничиваем
    const now = mskNow();
    const inside = a <= b ? (now >= a && now < b) : (now >= a || now < b);  // окно через полночь
    return { ok: inside, note: inside ? '' : `вне окна смены ${shiftFrom}–${shiftTo} МСК` };
  }

  // ---------- пауза под SLA ----------
  //
  // В прежней CRM пауза была про правдоподобность: 30–120 секунд, чтобы бот не
  // отвечал ровно каждые 12 секунд. Здесь у неё второй хозяин — таймер
  // карточки. Ответ после нормального предела фиксируется как просрочка,
  // поэтому пауза не может быть длиннее остатка минус запас.
  async function humanPause(text) {
    if (state.abort && state.running) {
      throw Object.assign(new Error('остановлено оператором'), { aborted: true });
    }
    const cfg = await chrome.storage.local.get(['pauseMin', 'pauseMax', 'slaGuard']);
    const lo = Number(cfg.pauseMin), hi = Number(cfg.pauseMax);
    let ms = 0;
    if (cfg.pauseMin !== '' && cfg.pauseMax !== '' && hi > 0) {
      const a = Math.max(0, Math.min(lo, hi)), b = Math.max(lo, hi);
      ms = (a + Math.random() * (b - a)) * 1000;
    } else {
      ms = (8000 + Math.random() * 22000);                 // 8–30 секунд по умолчанию
      ms += Math.min(String(text || '').length * 25, 12000);
    }

    // Остаток срока. Отрицательный — уже просрочено, ждать нечего.
    const left = deadlineSecs();
    const guard = Number(cfg.slaGuard) || 45;              // запас на отправку и доставку
    if (left !== null) {
      if (left <= 0) { log('срок вышел — отвечаю без паузы'); return; }
      const cap = Math.max(0, (left - guard) * 1000);
      if (ms > cap) {
        ms = cap;
        if (cap <= 0) { log(`до срока ${left}с — отвечаю без паузы`); return; }
      }
    }
    if (ms < 1000) return;
    log(`пауза ${Math.round(ms / 1000)}с${left !== null ? ` (до срока ${left}с)` : ''}`);
    await sleepAbortable(ms);
  }

  async function sleepAbortable(ms) {
    const till = Date.now() + ms;
    while (Date.now() < till) {
      if (state.abort && state.running) {
        throw Object.assign(new Error('остановлено оператором'), { aborted: true });
      }
      await wait(Math.min(1000, till - Date.now()));
    }
  }

  // ---------- распознавание ситуаций ----------

  const SUSPECTS_BOT = new RegExp(
    '(^|[^а-яёa-z])(' + [
      'это бот', 'вы бот', 'ты бот', 'бот ли', 'с ботом', 'ботом говорю',
      'бот отвечает', 'отвечает бот', 'робот', 'нейросет[а-яё]*', 'нейронк[а-яё]*',
      'искусственный интеллект', 'автоответчик', 'это ии', 'отвечает ии',
      'не человек', 'живой человек есть', 'вы человек',
    ].join('|') + ')($|[^а-яёa-z])', 'i');

  const CANCELLED = /(^|\s)(отмена|отменяю|разобрал(ся|ась)|сообразил(а)?|уже (нашёл|нашел|нашла|понял|поняла)|сам(а)? понял(а)?|не надо|не нужно|вопрос снят|вопросов нет|больше вопросов нет)(\s|[.,!)]|$)/i;

  const THANKS_CORE = new Set(['спасибо', 'спасибки', 'пасибо', 'благодарю', 'благодарствую',
    'мерси', 'thanks', 'понял', 'поняла', 'принял', 'принято', 'ясно',
    'заработало', 'сработало', 'получилось', 'помогло', 'помог', 'помогли',
    'выручили', 'отлично', 'супер']);
  const THANKS_FILLER = new Set(['ок', 'окей', 'ok', 'хорошо', 'всё', 'все', 'работает',
    'огромное', 'большое', 'вам', 'тебе', 'ура', 'класс', 'топ', 'круто', 'уже',
    'теперь', 'наконец', 'и', 'а', 'ну', 'о', 'вот', 'это', 'вроде', 'кажется',
    'ураа', 'мне', 'нам', 'всем', 'thank', 'you', 'much']);

  // Благодарность без вопроса. Правило CRM жёстче нашего старого: сначала
  // читаем сообщение целиком, потому что за «спасибо» часто прячется новый
  // вопрос, и тогда «Ответ не требуется» — прямое нарушение.
  function thanksOnly(text) {
    if (/[?？]/.test(String(text || ''))) return false;
    const t = String(text || '').toLowerCase()
      .replace(/[^\p{L}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 60) return false;
    const p = ` ${t} `;
    if (/ (не|но|а|или) /.test(p)) return false;
    const words = t.split(' ');
    const phrase = / (вс[её]|уже|теперь) (работает|ок|отлично) /.test(p);
    if (!phrase && !words.some((w) => THANKS_CORE.has(w))) return false;
    return words.every((w) => THANKS_CORE.has(w) || THANKS_FILLER.has(w));
  }

  // Клиент подтвердил, что заработало. Отличается от благодарности тем, что
  // здесь есть основание закрыть обращение по существу, а не «по статистике».
  const CONFIRMED_RE = /(зарабо?тал[аои]?|всё работает|все работает|получилось|помогло|подключил(ся|ась)|решен[оа]|решилось|всё ок|все ок)/i;

  // Отрицание рядом переворачивает смысл: «не заработало», «так и не помогло»,
  // «пока не получилось». Без этой проверки бот закрывал бы нерешённую
  // проблему как решённую — по главе 02 это прямое нарушение, и хуже того,
  // клиент остаётся с пометкой «решено» и без ответа.
  //
  // Границу слова \b использовать нельзя: в JS она привязана к латинице и на
  // кириллице не срабатывает — «не заработало» проходило мимо проверки.
  // Поэтому режем на слова и смотрим окно в два слова после отрицания:
  // трёх слов было много — «ничего не делал, но заработало» попадало под
  // отрицание, хотя «не» относится там к другому глаголу.
  // Только «не» и «ни». «Нет» отсюда убрано намеренно: по-русски глагол
  // отрицается через «не» («не работает»), а «нет» в начале реплики — это
  // почти всегда самопоправка, и дальше идёт хорошая новость.
  //
  // однажды на этом потерялось одно обращение: «А нет, вса получилось,
  // спасибо» прочиталось как отрицание, обращение осталось открытым.
  const NEG_WORDS = new Set(['не', 'ни']);
  const POS_STEMS = ['зарабо', 'работ', 'получ', 'помог', 'подключ', 'решил', 'решен', 'решилось'];

  function hasNegatedSuccess(text) {
    const words = String(text || '').toLowerCase()
      .replace(/[^\p{L}\s]+/gu, ' ').replace(/\s+/g, ' ').trim().split(' ');
    for (let i = 0; i < words.length; i++) {
      if (!NEG_WORDS.has(words[i])) continue;
      for (let j = i + 1; j <= Math.min(i + 2, words.length - 1); j++) {
        if (POS_STEMS.some((st) => words[j].startsWith(st))) return true;
      }
    }
    return false;
  }

  // Слова, после которых идёт продолжение разговора: «подключился, но сайты
  // не грузятся», «заработало, только медленно». Подтверждение в такой фразе
  // есть, а закрывать нельзя — вторая половина и есть новый вопрос.
  const MORE_WORDS = new Set(['но', 'однако', 'хотя', 'только', 'зато', 'правда',
    'а', 'подскажите', 'скажите', 'вопрос']);

  // Клиент сказал, что заработало, и ничего больше не спросил. Отдельно от
  // thanksOnly: там нужна благодарность, а «Подключился» — это не «спасибо».
  // Такие обращения уходили модели, а модель на голом «Подключился» отвечать
  // нечем — получалась эскалация вместо закрытия.
  function solvedOnly(text) {
    const t = String(text || '');
    if (/[?？]/.test(t)) return false;
    if (t.length > 120) return false;
    if (!confirmedFixed(t)) return false;
    const words = t.toLowerCase().replace(/[^\p{L}\s]+/gu, ' ').trim().split(/\s+/);
    return !words.some((w) => MORE_WORDS.has(w));
  }

  function confirmedFixed(text) {
    // Переносы строк схлопываем: «всё\nработает» — то же самое, что
    // «всё работает», а в CONFIRMED_RE между словами стоит обычный пробел.
    // В Telegram перенос посреди фразы — обычное дело, и подтверждение
    // из-за него терялось.
    const t = String(text || '').replace(/\s+/g, ' ');
    if (/[?？]/.test(t)) return false;        // вопрос, а не подтверждение
    if (hasNegatedSuccess(t)) return false;
    return CONFIRMED_RE.test(t);
  }

  // ---------- журнал ----------

  let journalWarned = false;

  async function record(entry) {
    try {
      const { journal = [] } = await chrome.storage.local.get(['journal']);
      journal.push({ ts: new Date().toISOString(), ...entry });
      // Журнал — единственный источник метрик; режем по объёму, а не по дате.
      while (journal.length > 6000) journal.shift();
      await chrome.storage.local.set({ journal });
    } catch (e) {
      if (!journalWarned) {
        journalWarned = true;
        log('журнал не пишется: ' + e.message, 'err');
        send('report', { text: `⚠️ Журнал не пишется: ${e.message}` }).catch(() => {});
      }
    }
  }

  async function recordError(where, message, client) {
    await record({ action: 'error', where, reason: String(message || '').slice(0, 300), client });
  }

  // Какие блоки клиент уже получил в этом обращении — чтобы не слать то же
  // самое второй раз. Окно — сутки.
  // Считаем только поле blocks — его пишет одна запись: та, где ответ реально
  // ушёл клиенту. Блоки из пропусков, эскалаций, недоставленных ответов и
  // ручных черновиков лежат отдельно, в draftBlocks, и сюда не попадают.
  //
  // однажды они попадали. Обращение #123: бот составил ASK_PROBLEM,
  // отправить не успел (переписка изменилась), но блок записался как
  // отправленный. Через минуту модель получила «ASK_PROBLEM уже отправляли»
  // и эскалировала «клиент не ответил на вопрос» — клиенту при этом никто
  // ничего не спрашивал, а он задал два внятных вопроса.
  // Обращение уже отдано человеку и с тех пор никто из сотрудников не отвечал.
  // Думать над ним второй раз нечем: картина та же, решение будет то же, а
  // стоит это сорока тысяч токенов за заход. Одно обращение однажды прошло через
  // семь таких эскалаций, одно обращение — через пять.
  //
  // Как только оператор ответит, обращение снова становится нашим: его
  // реплика в ленте свежее записи об эскалации, и проверка пропускает.
  async function escalatedWaiting(id, hours = 12) {
    if (!id) return null;
    try {
      const { journal = [] } = await chrome.storage.local.get(['journal']);
      let last = null;
      for (const e of journal) if (String(e.ticket) === String(id)) last = e;
      if (!last || last.action !== 'escalate') return null;

      const mins = Math.round((Date.now() - new Date(last.ts).getTime()) / 60000);
      if (!Number.isFinite(mins) || mins > hours * 60) return null;

      const lo = lastOperatorRow();
      const opMins = lo ? minutesAgo(lo) : null;
      if (opMins !== null && opMins < mins) return null;   // сотрудник ответил позже

      return `уже у оператора ${mins} мин, ответа от сотрудника не было`;
    } catch { return null; }
  }

  async function sentBlocks(id, hours = 24) {
    if (!id) return [];
    try {
      const { journal = [] } = await chrome.storage.local.get(['journal']);
      const since = Date.now() - hours * 3600e3;
      const out = [];
      for (const e of journal) {
        if (String(e.ticket) !== String(id)) continue;
        if (new Date(e.ts).getTime() < since) continue;
        for (const b of (e.blocks || [])) {
          const up = String(b).trim().toUpperCase();
          if (up && !out.includes(up)) out.push(up);
        }
      }
      return out;
    } catch { return []; }
  }

  async function repliesToday() {
    try {
      const { journal = [] } = await chrome.storage.local.get(['journal']);
      const since = new Date(); since.setHours(0, 0, 0, 0);
      return journal.filter((e) => e.action === 'reply'
        && new Date(e.ts).getTime() >= since.getTime()).length;
    } catch { return 0; }
  }

  // ---------- замок ----------
  //
  // Один и тот же диалог не разбираем дважды подряд: и запрос в модель стоит
  // денег, и клиент получает дубликат.
  const LOCK_TTL_MS = 6 * 3600e3;

  function fingerprint(s) {
    const t = String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  async function readLocks() {
    try { const { locks = {} } = await chrome.storage.local.get(['locks']); return locks; }
    catch { return {}; }
  }

  // bypass — какие замки не считаются препятствием. Нужен ровно для одного
  // случая: обращение когда-то пропустили, а теперь клиент поблагодарил или
  // сказал, что заработало. Замок от пропуска держал такие обращения
  // открытыми часами — одно обращение с «Спасибо, помогло» бот перечитал 12 раз за
  // смену и ни разу не закрыл. Замок от собственного ответа обходить нельзя:
  // клиенту уйдёт второе сообщение.
  async function lockReason(id, last, bypass = null) {
    if (!id) return null;
    const locks = await readLocks();
    const l = locks[id];
    if (!l) return null;
    if (Date.now() - l.ts > LOCK_TTL_MS) return null;
    if (l.fp !== fingerprint(last)) return null;      // клиент написал новое — работаем
    if (bypass && bypass.includes(l.action)) return null;
    const mins = Math.round((Date.now() - l.ts) / 60000);
    return `уже разбирали ${mins} мин назад (${l.action})`;
  }

  async function setLock(id, action, last) {
    if (!id) return;
    try {
      const locks = await readLocks();
      locks[id] = { ts: Date.now(), action, fp: fingerprint(last) };
      const cutoff = Date.now() - LOCK_TTL_MS;
      for (const k of Object.keys(locks)) if (!locks[k] || locks[k].ts < cutoff) delete locks[k];
      await chrome.storage.local.set({ locks });
    } catch { /* замок не критичен */ }
  }

  // ---------- чёрный список ----------

  function normName(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  async function denyReason(name) {
    const { denyList = '' } = await chrome.storage.local.get(['denyList']);
    const n = normName(name);
    if (!n) return null;
    for (const raw of String(denyList).split('\n')) {
      const p = normName(raw);
      if (p && n.includes(p)) return `в чёрном списке (${raw.trim()})`;
    }
    return null;
  }

  async function addToDeny(name, why) {
    try {
      const { denyList = '' } = await chrome.storage.local.get(['denyList']);
      const line = String(name || '').trim();
      if (!line) return;
      if (normName(denyList).includes(normName(line))) return;
      await chrome.storage.local.set({ denyList: (denyList ? denyList + '\n' : '') + line });
      log(`<b>${line}</b> — в чёрный список: ${why}`);
    } catch { /* не критично */ }
  }

  // ---------- эскалация ----------
  //
  // В прежней CRM эскалация была молчанием: клиенту не уходило ничего, диалог
  // подбирал оператор. В CRM молчание = просрочка, поэтому эскалация стала
  // действием. Два режима, выбор в настройках:
  //
  //   engineer — отправить короткое сообщение и поставить «Передать инженеру».
  //              Подходит, когда нужен инженерный доступ.
  //   notify   — ничего не отправлять, диалог оставить как есть, карточку
  //              прислать в Telegram. Ближе к старому поведению: разбирает
  //              человек. Значение по умолчанию.
  //
  // Тексты пишет код, а не модель: в базе знаний фразы «передам специалисту»
  // запрещены, и модель в таких случаях возвращает пустоту.
  // Режим «придержать»: клиенту уходит короткое подтверждение, что его
  // увидели, с действием «Ответить и ждать». Таймер ответа останавливается,
  // обращение уходит из «Нужен ответ» — и дальше его разбирает человек по
  // карточке из Telegram.
  //
  // Одна и та же фраза во всех обращениях — самый заметный след автомата,
  // поэтому вариантов несколько, выбор по номеру обращения. Первая —
  // формулировка оператора, остальные под неё подогнаны.
  const HOLD_SAID = [
    'разбираюсь по вашему обращению, немного времени',
    'разбираюсь по вашему вопросу, нужно немного времени',
    'смотрю ваше обращение, немного времени',
    'разбираюсь, потребуется немного времени',
  ];

  const HANDOFF = [
    'Передаю вопрос инженеру — нужен доступ на нашей стороне. Ответ будет здесь.',
    'Здесь потребуется проверка инженера. Передаю вопрос, результат напишу в этом чате.',
    'Подключаю инженера: нужна проверка на стороне сервиса. Вернусь сюда с результатом.',
    'Вопрос ушёл инженеру — своими силами тут не проверить. Ответ придёт в этот чат.',
  ];

  // Фразы при закрытии. Одна и та же в каждом закрытом обращении — самый
  // заметный след автомата: закрытий за смену больше двухсот. Поэтому
  // несколько вариантов, выбор по номеру обращения: один и тот же клиент
  // всегда получает один и тот же вариант, а подряд идущие — разные.
  //
  // Все формулировки без родовых окончаний: бот пишет от имени оператора,
  // а операторы разного пола. «Рада была помочь» из инструкции CRM написана
  // женским родом — она годится не всем.
  // Два набора, и путать их нельзя.
  //
  // однажды оценка ИИ разобрала одно обращение: клиент спросил, их ли
  // приложение в Google Play, получил ссылку и написал «Спасибо большое».
  // Бот ответил «Хорошо, что заработало» — и проверка записала: «фраза не
  // опирается на сообщения клиента». Клиент ни разу не говорил, что что-то
  // заработало; фраза приписала результат, которого в переписке нет.
  //
  // Поэтому про успех говорим ТОЛЬКО когда клиент сам его подтвердил.
  // На «спасибо» без подтверждения — нейтральное прощание.
  const CLOSE_SAID_OK = [
    'Отлично, что получилось. Если понадобится что-то ещё — пишите сюда.',
    'Хорошо, что заработало. Если снова понадобится помощь, напишите здесь.',
    'Рады, что решилось. Будут сложности — возвращайтесь в этот чат.',
    'Раз всё работает — закрываю обращение. Появятся вопросы, пишите.',
  ];

  const CLOSE_SAID_NEUTRAL = [
    'Если понадобится что-то ещё — пишите сюда.',
    'Тогда закрываю обращение. Будут сложности — возвращайтесь в этот чат.',
    'Обращайтесь, если снова понадобится помощь.',
    'Готово. Появятся вопросы — пишите, разберёмся.',
  ];

  // confirmed — клиент прямо написал, что заработало.
  async function closingPhrase(id, confirmed) {
    const key = confirmed ? 'closeTextOk' : 'closeText';
    const cfg = await chrome.storage.local.get([key]);
    const list = String(cfg[key] || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const pool = list.length ? list : (confirmed ? CLOSE_SAID_OK : CLOSE_SAID_NEUTRAL);
    return pool[Math.abs(hashNum(String(id))) % pool.length];
  }

  function hashNum(s) {
    let h = 0;
    for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return h;
  }

  // Для инженера нужен контекст: симптом, что уже сделали, с каким итогом.
  // Это требование главы 02 CRM, без него передача считается неполной.
  function escalationNote(d, last) {
    const did = operatorDid();
    return [
      `Симптом: ${d.symptom || d.topic || (last || '').slice(0, 120) || '—'}`,
      `Уже сделано: ${did.length ? did.join('; ') : (d.tried || '—')}`,
      `Результат: ${d.seen || 'проблема сохраняется'}`,
      `Причина передачи: ${d.reason || '—'}`,
    ].join('\n');
  }

  // ---------- состояние ----------

  const state = {
    running: false, stop: false, abort: false,
    seen: new Set(),
    retried: new Set(),
    stats: { done: 0, replied: 0, escalated: 0, skipped: 0, closed: 0, errors: 0 },
  };

  // ---------- обращение к модели ----------
  //
  // Один запрос в обычном случае и два в редком: когда выбранный блок
  // нельзя собрать без данных кабинета. Второй запрос дешевле, чем кажется —
  // промпт кэшируется целиком, платим только за разницу.
  async function askModel(payload) {
    let d = await send('decide', { payload });
    if (d.action !== 'needAccount') return { d, account: null };

    const { useVpnPanel } = await chrome.storage.local.get(['useVpnPanel']);
    if (useVpnPanel === false) {
      // Панель выключена настройкой — честно отдаём человеку, а не молчим.
      return { d: { ...d, action: 'escalate', message: '',
                    reason: `нужны данные кабинета (${d.need || '—'}), а открывать «Управление VPN» запрещено настройкой` },
               account: null };
    }

    log(`<span class="ja-dim">${d.need || 'нужен кабинет'} — открываю «Управление VPN»</span>`);
    const account = await readVpnPanel();
    if (!account) {
      return { d: { ...d, action: 'escalate', message: '',
                    reason: `не удалось прочитать кабинет VPN (${d.need || '—'})` },
               account: null };
    }

    d = await send('decide', { payload: { ...payload, account } });
    if (d.action === 'needAccount') {
      // Кабинет прочитан, а данных всё равно не хватило: в блоке переменная,
      // которой в кабинете нет (например {дни} — это настройка компенсации).
      return { d: { ...d, action: 'escalate', message: '',
                    reason: `кабинет прочитан, но ${d.need || 'данных не хватает'}` },
               account };
    }
    return { d, account };
  }

  // ---------- разбор одного диалога ----------

  async function processOpenChat() {
    const id = ticketId();
    const name = clientName();
    const ch = channel();
    const st = stage();

    const base = { ticket: id, client: name, channel: ch, stage: st.key, project: dialogProject() };

    // Чужой проект. Вкладка бренда заменила старый костыль «имя ровно
    // "Клиент" = eSIM»: теперь принадлежность видна честно.
    const { project = 'VPN' } = await chrome.storage.local.get(['project']);
    const dp = dialogProject();
    if (project && dp && dp.toLowerCase() !== String(project).toLowerCase()) {
      state.stats.skipped++;
      return { kind: 'skip', note: `чужой проект (${dp})` };
    }

    // Лента могла быть отрисована не до конца. Дочитываем её ДО того, как
    // делать выводы: иначе на длинном обращении бот увидит только старые
    // реплики и решит, что отвечать нечего.
    await scrollHistoryToEnd();

    let last = lastFromClient();

    // Сверка с самой CRM. Она считает этап на сервере, мы — по отрисованным
    // строкам, и её слово весомее. «Нужен ответ» при пустом last означает,
    // что мы чего-то не дочитали: крутим ещё раз и пробуем снова.
    if (!last && crmWantsAnswer() === true) {
      await wait(900);
      await scrollHistoryToEnd(20);
      last = lastFromClient();
      if (!last) {
        // Дочитали, а реплики клиента всё равно нет. Молча пропускать нельзя:
        // CRM считает, что клиент ждёт ответа, и обращение уйдёт в просрочку.
        state.stats.skipped++;
        // Кладём в журнал слепок ленты: без него причину такого расхождения
        // потом не восстановить — остаётся гадать, что видел бот.
        const tail = messageRows().slice(-4).map((r) => {
          const who = rowKind(r);
          const t = rowText(r).replace(/\s+/g, ' ').slice(0, 40);
          return `${who}@${rowTime(r) || '?'}: ${t}`;
        });
        await record({ ...base, action: 'skip',
                       reason: 'этап «Нужен ответ», но в ленте последним стоит сотрудник',
                       topic: 'разметка',
                       answer: `реплик в ленте: ${messageRows().length}\nхвост: ${tail.join(' | ')}` });
        log(`<b>#${id}</b> — этап «Нужен ответ», а реплики клиента не видно. Проверьте вручную.`, 'err');
        return { kind: 'skip', note: 'этап «Нужен ответ», но реплики клиента не видно' };
      }
    }

    if (!last) {
      state.stats.skipped++;
      // «Ждём клиента» — не событие, а нормальное состояние: эти обращения
      // бот просматривает при каждом проходе и будет просматривать дальше.
      // В журнал их не пишем: однажды они дали 123 записи из 163, и
      // всё полезное в них утонуло. Счётчик пропусков их всё равно считает.
      if (stage().key !== 'waiting_client') {
        await record({ ...base, action: 'skip', reason: 'клиент не писал последним',
                       topic: stage().label || '' });
      }
      return { kind: 'skip', note: 'клиент не писал последним' };
    }

    // Обращение уже закрыто и клиент ничего нового не написал — не трогаем.
    if (st.key === 'closed' && !last) { state.stats.skipped++; return { kind: 'skip', note: 'закрыто' }; }

    // Диалог у инженера: там работает инженер, писать поверх нельзя.
    if (st.key === 'engineer') {
      state.stats.skipped++;
      await record({ ...base, action: 'skip', question: last, reason: 'обращение у инженера' });
      return { kind: 'skip', note: 'у инженера' };
    }

    const deny = await denyReason(name);
    if (deny) {
      state.stats.skipped++;
      await record({ ...base, action: 'skip', question: last, reason: deny, topic: 'чёрный список' });
      return { kind: 'skip', note: deny };
    }

    // Диалог закреплён за коллегой, и он писал недавно. Правило CRM: чужой
    // закреплённый диалог нельзя просто забрать ответом.
    const { myName = '' } = await chrome.storage.local.get(['myName']);
    MY_NAME = myName;                    // копия для разметки переписки
    const card = readCard();
    const owner = card['Ответственный'] || '';
    const mine = normName(myName);
    //
    // Две независимые причины не лезть, и хватает любой.
    //
    // однажды в прежней CRM бот написал «Перезагрузите ваше устройство» поверх
    // коллеги, который в ту же минуту выводил клиенту деньги. Там сторож
    // требовал совпадения сразу нескольких условий и из-за этого молчал.
    // Здесь была та же ошибка: проверка начиналась с «закреплён за другим»,
    // а обращение висело в общем пуле — и живой разговор коллеги сторож
    // не замечал вовсе.
    if (mine) {
      const lo = lastOperatorRow();
      const who = lo ? normName(txt(lo.querySelector(S.msgMeta))) : '';
      const mins = lo ? minutesAgo(lo) : null;

      // 1. Последним из сотрудников писал не я, и писал недавно.
      //    Время неизвестно — считаем свежим: промолчать дешевле.
      if (who && who !== mine && (mins === null || mins < 15)) {
        state.stats.skipped++;
        await record({ ...base, action: 'skip', question: last,
                       reason: `в диалоге ${who}, писал ${mins === null ? '?' : mins} мин назад`,
                       topic: 'занят оператором' });
        return { kind: 'skip', note: `в диалоге ${who}` };
      }

      // 2. Обращение закреплено за коллегой. Правило CRM: чужой закреплённый
      //    диалог нельзя просто забрать ответом.
      if (owner && normName(owner) !== mine && !/общий пул/i.test(owner)) {
        state.stats.skipped++;
        await record({ ...base, action: 'skip', question: last,
                       reason: `закреплён за ${owner}`, topic: 'занят оператором' });
        return { kind: 'skip', note: `закреплён за ${owner}` };
      }
    }

    // Клиент спросил, бот ли это. Продолжать после такого вопроса нельзя.
    if (SUSPECTS_BOT.test(last)) {
      await addToDeny(name, 'спросил, бот ли это');
      state.stats.escalated++;
      await record({ ...base, action: 'escalate', question: last,
                     reason: 'клиент спросил, бот ли это', topic: 'подозрение' });
      send('escalateCard', { text: `🤖 ${name || 'клиент'} спросил, бот ли это · обращение #${id}` }).catch(() => {});
      return { kind: 'escalate', note: 'спросил, бот ли это' };
    }

    // Сообщение, которое заканчивается закрытием: замок от прошлого пропуска
    // ему не помеха.
    const closing = (CANCELLED.test(last) && last.length < 120)
      || thanksOnly(last) || solvedOnly(last);

    const locked = await lockReason(id, last, closing ? ['skip'] : null);
    if (locked) {
      state.stats.skipped++;
      // В журнал не пишем: за одну смену такие записи дали 94 строки из 283,
      // и всё содержательное в них утонуло. Счётчик пропусков их считает,
      // в панели строка видна.
      return { kind: 'skip', note: locked };
    }

    // Клиент сам снял вопрос.
    if (CANCELLED.test(last) && last.length < 120) {
      await setLock(id, 'closed', last);
      const r = await sendReply('', closeAction());
      state.stats.closed++;
      await record({ ...base, action: 'closed', question: last, stage: 'close',
                     reason: 'клиент снял вопрос', delivery: r.delivery });
      return { kind: 'closed', note: 'снял вопрос' };
    }

    // Благодарность без вопроса → «Ответ не требуется», текст пустой.
    // CRM запишет решение в историю, клиенту ничего не уйдёт.
    if (thanksOnly(last)) {
      await setLock(id, 'closed', last);
      // «Ответ не требуется» разрешает и пустое поле, и короткий текст.
      // Инструкция CRM прямо приводит пример «Рада, что всё получилось» —
      // то есть ответить на благодарность нормально, молчать тоже можно.
      const { closeSilent: cs = false } = await chrome.storage.local.get(['closeSilent']);
      // confirmedFixed, а не факт благодарности: «спасибо, всё получилось» —
      // это подтверждение, а просто «спасибо большое» — нет.
      const bye = cs ? '' : await closingPhrase(id, confirmedFixed(last));
      const act = closeAction();
      const r = await sendReply(bye, act);
      state.stats.closed++;
      await record({ ...base, action: 'closed', question: last, stage: 'close',
                     answer: bye, crmAction: act,
                     reason: 'благодарность без вопроса', delivery: r.delivery });
      return { kind: 'closed', note: 'поблагодарил' };
    }

    // Клиент подтвердил, что заработало, и больше ничего не спросил.
    // Спрашивать модель тут не о чем: ни вопроса, ни симптома в сообщении
    // нет, и она честно возвращает эскалацию. Закрываем сами.
    if (solvedOnly(last)) {
      await setLock(id, 'closed', last);
      const { closeSilent: cs2 = false } = await chrome.storage.local.get(['closeSilent']);
      const bye = cs2 ? '' : await closingPhrase(id, true);
      // Здесь именно «Решено · закрыть», а не «Ответ не требуется»: проблема
      // решена, и оценка ИИ смотрит на обоснованность закрытия.
      const act = availableActions().has(ACT.close) ? ACT.close : closeAction();
      const r = await sendReply(bye, act);
      state.stats.closed++;
      await record({ ...base, action: 'closed', question: last, stage: 'close',
                     answer: bye, crmAction: act,
                     reason: 'клиент подтвердил, что заработало', delivery: r.delivery });
      return { kind: 'closed', note: 'подтвердил — закрыл' };
    }

    // Обращение уже у человека — второй раз думать не над чем.
    const waiting = await escalatedWaiting(id);
    if (waiting) {
      state.stats.skipped++;
      await record({ ...base, action: 'skip', question: last, reason: waiting, topic: 'у оператора' });
      return { kind: 'skip', note: waiting };
    }

    // Дальше нужен ответ модели.
    const shot = await grabLastImage();
    const hadImg = shot.had;
    const image = shot.image;
    const sent = await sentBlocks(id);

    const t0 = Date.now();
    const { d, account } = await askModel({
      history: history() + shotNote(shot), account: null, clientName: name,
      last, image, sent, did: operatorDid(),
    });
    const msModel = Date.now() - t0;
    if (account) base.balance = account.balance;

    await setLock(id, d.action === 'escalate' ? 'escalate' : 'reply', last);

    // Команды выдачи ключа в CRM пока невозможны: админ-бот в переписку не
    // пишет, ключи живут в отдельной панели. Молча игнорировать нельзя —
    // иначе клиент получит обещание вместо ключа.
    if (d.command) {
      log(`команда ${d.command} пропущена — в CRM выдача ключей не подключена`);
      d.command = '';
    }

    if (d.action === 'escalate') {
      const cfgEsc = await chrome.storage.local.get(['escalateMode', 'holdText']);
      const escalateMode = cfgEsc.escalateMode || 'hold';
      const note = escalationNote(d, last);
      send('escalateCard', {
        text: `🔴 ${name || 'клиент'} · обращение #${id}\n${note}\n${location.href}`,
        history: `📄 Переписка #${id} — ${name || 'клиент'}\n\n${history()}`,
      }).catch(() => {});

      if (escalateMode === 'engineer') {
        const text = HANDOFF[Math.abs(hashNum(String(id))) % HANDOFF.length];
        await humanPause(text);
        const r = await sendReply(text, ACT.engineer);
        state.stats.escalated++;
        await record({ ...base, action: 'escalate', question: last, answer: text,
                       reason: d.reason, topic: d.topic, gap: d.gap, draftBlocks: d.blocks,
                       provider: d.provider, model: d.model, usage: d.usage,
                       delivery: r.delivery, handoff: 'engineer' });
        return { kind: 'escalate', note: `${d.reason || ''} → инженеру`, usage: d.usage };
      }

      if (escalateMode === 'hold') {
        // Клиенту — короткое подтверждение, что его увидели; в CRM —
        // «Ответить и ждать». Таймер ответа останавливается, обращение
        // уходит из «Нужен ответ», карточка с перепиской уже в Telegram.
        const pool = String(cfgEsc.holdText || '').split('\n').map((x) => x.trim()).filter(Boolean);
        const list = pool.length ? pool : HOLD_SAID;
        const text = list[Math.abs(hashNum(String(id))) % list.length];
        await humanPause(text);
        const r = await sendReply(text, ACT.reply);
        state.stats.escalated++;
        await record({ ...base, action: 'escalate', question: last, answer: text,
                       reason: d.reason, topic: d.topic, gap: d.gap, draftBlocks: d.blocks,
                       crmAction: ACT.reply, provider: d.provider, model: d.model,
                       usage: d.usage, delivery: r.delivery, handoff: 'hold' });
        return { kind: 'escalate', note: `${d.reason || ''} → придержал`, usage: d.usage };
      }

      // notify: ничего не отправляем и не меняем — разбирает человек.
      state.stats.escalated++;
      await record({ ...base, action: 'escalate', question: last, answer: '',
                     reason: d.reason, topic: d.topic, gap: d.gap, draftBlocks: d.blocks,
                     provider: d.provider, model: d.model, usage: d.usage, handoff: 'notify' });
      return { kind: 'escalate', note: d.reason, usage: d.usage };
    }

    const confirmed = confirmedFixed(last);
    const { closeSilent } = await chrome.storage.local.get(['closeSilent']);
    const text = String(d.message || '').trim();

    // Модель ничего не написала, а клиент подтвердил, что заработало.
    // Раньше это был пропуск: обращение оставалось открытым и висело до
    // просрочки, хотя вопрос закрыт. Закрываем без сообщения — CRM запишет
    // решение в историю, клиенту ничего не уйдёт.
    if (!text && confirmed) {
      // Молчание здесь читается как «бросили трубку». Короткая фраза стоит
      // ноль токенов — её пишет код, а не модель.
      const bye = closeSilent ? '' : await closingPhrase(id, true);
      if (bye) await humanPause(bye);
      const r = await sendReply(bye, ACT.close);
      state.stats.closed++;
      await record({ ...base, action: 'closed', question: last, answer: bye,
                     reason: 'клиент подтвердил решение',
                     crmAction: ACT.close, delivery: r.delivery, draftBlocks: d.blocks,
                     provider: d.provider, model: d.model, usage: d.usage });
      return { kind: 'closed', note: bye ? 'подтвердил, закрыл с прощанием' : 'подтвердил, закрыл молча' };
    }

    if (!text) {
      state.stats.skipped++;
      await record({ ...base, action: 'skip', question: last, reason: 'модель вернула пустой ответ' });
      return { kind: 'skip', note: 'пустой ответ' };
    }

    // Дневной предел. В CRM он весомее, чем в прежней CRM: каждый ответ закрепляет
    // обращение за вами, и все его сроки становятся вашими.
    const { dayLimit = '' } = await chrome.storage.local.get(['dayLimit']);
    const cap = parseInt(dayLimit, 10) || 0;
    if (cap && (await repliesToday()) >= cap) {
      state.stats.skipped++;
      await record({ ...base, action: 'skip', question: last, reason: `дневной предел ${cap}` });
      return { kind: 'skip', note: 'дневной предел' };
    }

    // Клиент подтвердил, что заработало → закрываем по существу.
    // Правило CRM: «инструкцию отправили» и «проблема решена» — разные вещи,
    // поэтому закрываем только на прямом подтверждении клиента.
    const action = confirmed ? ACT.close : ACT.reply;

    // Закрывать можно и молча: действие живёт отдельно от текста, пустое
    // поле ввода отправку не блокирует. По умолчанию всё же пишем итог —
    // глава 02 просит «коротко описать результат, а не только факт
    // завершения», и оценка ИИ смотрит на содержание. Настройка на случай,
    // если окажется, что прощальные фразы только раздражают.
    const body = (action === ACT.close && closeSilent) ? '' : d.message;

    if (body) await humanPause(body);

    // Последняя сверка перед отправкой.
    const stale = staleReason(last, mine);
    if (stale) {
      state.stats.skipped++;
      log(`<b>#${id}</b> — ${stale.text}${stale.retry ? ', разберу заново' : ', ответ не отправлен'}`);
      await record({ ...base, action: 'skip', question: last, answer: body,
                     reason: stale.text, topic: 'разошлось с диалогом', draftBlocks: d.blocks });
      // Клиент дописал — это не помеха, а новые данные. Автопилот зайдёт
      // в обращение ещё раз в этом же проходе, уже с полным сообщением.
      return { kind: 'skip', note: stale.text, again: stale.retry };
    }

    const r = await sendReply(body, action);

    if (!r.ok) {
      // Доставка не прошла. Повтор запрещён — уйдёт дубликат.
      state.stats.errors++;
      await record({ ...base, action: 'error', question: last, answer: d.message,
                     reason: 'доставка не прошла', delivery: r.delivery, draftBlocks: d.blocks });
      send('report', { text: `⚠️ Доставка не прошла · обращение #${id} · ${name || ''}` }).catch(() => {});
      return { kind: 'error', note: 'доставка не прошла' };
    }

    if (action === ACT.close) state.stats.closed++; else state.stats.replied++;
    await record({ ...base, action: action === ACT.close ? 'closed' : 'reply',
                   question: last, answer: body,
                   topic: d.topic, gap: d.gap, source: d.source, stageHint: d.stage,
                   blocks: d.blocks, provider: d.provider, model: d.model, usage: d.usage,
                   img: hadImg ? (image ? 'ok' : '504/недоступно') : '', crmAction: action,
                   delivery: r.delivery, msModel });
    return { kind: action === ACT.close ? 'closed' : 'reply', note: d.topic || '', usage: d.usage };
  }

  // ---------- автопилот ----------

  async function autopilot(limit, remote = false) {
    if (state.running) return;
    Object.assign(state, {
      running: true, stop: false, abort: false, seen: new Set(), retried: new Set(),
      stats: { done: 0, replied: 0, escalated: 0, skipped: 0, closed: 0, errors: 0 },
    });
    $('.ja-auto-run').textContent = 'Стоп';
    log('<b>автопилот запущен</b>');

    try {
      const sw = await shiftWindow();
      if (!sw.ok) { log(`<b>${sw.note}</b> — не запускаюсь`, 'err'); return; }

      const cfg = await chrome.storage.local.get(['project', 'folders', 'folder']);
      const project = cfg.project || 'VPN';

      // Папки разбираются по порядку, сверху вниз: сначала то, что назначено
      // лично вам, потом общий пул. Порядок задаётся в настройках — это и есть
      // приоритет. Пока верхняя папка не пуста, до нижних дело не доходит.
      //
      // Старая настройка с одной папкой поддерживается: если список не задан,
      // берём её.
      const folders = String(cfg.folders || cfg.folder || 'Входящие вам\nПереданные вам\nОбщие входящие')
        .split('\n').map((x) => x.trim()).filter(Boolean);

      if (!(await selectProject(project))) {
        log(`вкладка проекта «${project}» не найдена`, 'err');
        return;
      }

      const mult = loadMultiplier();
      if (mult > 1) log(`<b>режим нагрузки ×${mult}</b> — сроки растянуты`, 'w2');
      log(`<span class="ja-dim">порядок папок: ${folders.join(' → ')}</span>`);

      const cap = limit > 0 ? limit : Infinity;
      let fi = 0;                 // какая папка разбирается сейчас

      while (!state.stop) {
        if (state.stats.done >= cap) { log('лимит исчерпан'); break; }
        if (fi >= folders.length) { log('очередь пуста'); break; }

        const sw2 = await shiftWindow();
        if (!sw2.ok) { log(`<b>${sw2.note}</b> — останавливаюсь`, 'err'); break; }

        const folder = folders[fi];
        if (!(await openFolder(folder))) {
          log(`папка «${folder}» не найдена — пропускаю`, 'err');
          fi++;
          continue;
        }

        // Ждём, пока CRM отдаст и счётчик, и список. Оба приходят не сразу,
        // и любое чтение раньше показывает пустоту, которой нет.
        let rows = listRows();
        let want = folderCount(folder);
        for (let i = 0; i < 12; i++) {
          if (want !== null && (rows.length || want === 0)) break;
          await wait(600);
          rows = listRows();
          want = folderCount(folder);
        }

        const fresh = rows.filter((r) => !state.seen.has(r.id));

        // Одно слово «разобрана» стояло на трёх разных случаях: папка пуста,
        // всё в ней уже смотрели на этом заходе, и список не прогрузился.
        // Третий — настоящая ошибка, а выглядел как первые два. Теперь
        // строка печатается на каждом заходе в папку и говорит, что есть.
        const N = (n) => `${n} ${plural(n, 'обращение', 'обращения', 'обращений')}`;
        if (want && !rows.length) {
          // На вкладке висят обращения, у которых идёт срок, а списка нет.
          log(`<b>«${folder}»: счётчик ${want}, список пуст</b> — CRM не отдала строки`, 'err');
          await recordError('автопилот', `папка «${folder}»: счётчик ${want}, строк 0`, '');
        } else if (want === null && !rows.length) {
          // Счётчик так и не пришёл за семь секунд: CRM всё ещё грузится.
          // «Пусто» тут сказать нельзя — мы просто не знаем.
          log(`<b>«${folder}»: CRM не прогрузилась</b> — счётчика нет, список пуст`, 'err');
          await recordError('автопилот', `папка «${folder}»: счётчик не пришёл`, '');
        } else if (!rows.length) {
          log(`<span class="ja-dim">«${folder}»: пусто</span>`);
        } else if (fresh.length) {
          log(`<span class="ja-dim">«${folder}»: ${N(rows.length)}, новых ${fresh.length} — беру</span>`);
        } else {
          log(`<span class="ja-dim">«${folder}»: ${N(rows.length)}, все уже смотрел в этом заходе</span>`);
        }

        const next = fresh[0];
        if (!next) {
          // Переходим к следующей папке по приоритету, а не выходим: в прежней CRM
          // здесь была ровно эта дыра — «Мои» не доходили до разбора, потому
          // что лимит съедали «Входящие».
          fi++;
          continue;
        }
        state.seen.add(next.id);

        if (!(await openRow(next.id))) {
          state.stats.skipped++;
          log(`<b>#${next.id}</b> — не удалось открыть, пропускаю`, 'err');
          await backToList();
          continue;
        }

        try {
          const res = await processOpenChat();
          // Клиент дописал сообщение, пока готовился ответ. Забывать обращение
          // до следующего прохода нельзя — срок у него идёт сейчас. Снимаем
          // отметку «видел», и автопилот вернётся к нему тут же, с полным
          // текстом. Один раз за проход: иначе клиент, который печатает
          // без остановки, зациклит бота на себе.
          if (res.again && !state.retried.has(next.id)) {
            state.retried.add(next.id);
            state.seen.delete(next.id);
          }
          if (res.kind !== 'skip') state.stats.done++;
          const u = res.usage
            ? ` <span class="ja-dim">[вход ${(res.usage.in || 0) + (res.usage.cacheRead || 0)} · выход ${res.usage.out || 0}]</span>`
            : '';
          const num = res.kind === 'skip' ? '·' : `${state.stats.done}.`;
          log(`<b>${num} #${next.id} ${next.name}</b> — ${res.kind}: ${res.note}${u}`);
        } catch (e) {
          if (e && e.aborted) { log(`<b>#${next.id}</b> — остановлено`); break; }
          state.stats.done++;
          state.stats.errors++;
          log(`<b>#${next.id}</b> — ошибка: ${e.message}`, 'err');
          await recordError('автопилот', e.message, next.name);
        }

        await backToList();
        await wait(700);

        // После каждого разобранного обращения возвращаемся к верхней папке.
        // Пока бот работал, туда могло прилететь новое назначение лично вам,
        // а у него срок идёт с момента поступления. Стоит это два лишних
        // клика по папкам — дешевле одной просрочки.
        fi = 0;
      }

      const s = state.stats;
      // «Обработано» считало только то, что съело лимит, и при очереди из
      // одних ожидающих показывало ноль — читалось как «бот ничего не делал».
      const looked = s.done + s.skipped;
      const tail = `просмотрено ${looked} · ответил ${s.replied} · закрыл ${s.closed}`
        + ` · эскалировал ${s.escalated} · пропустил ${s.skipped} · ошибок ${s.errors}`;
      log(`<b>итог:</b> ${tail}`);
      if (remote) {
        send('report', { text: `✅ Готово: ${tail.replace(/ · /g, ', ')}` }).catch(() => {});
        send('bump', { done: s.done, replied: s.replied, escalated: s.escalated }).catch(() => {});
      }
    } finally {
      state.running = false;
      $('.ja-auto-run').textContent = 'Автопилот';
    }
  }

  // ---------- постоянный режим ----------

  const loop = { on: false, everyMs: 10 * 60000, timer: null };

  function setLoop(on, minutes) {
    loop.on = !!on;
    if (minutes) loop.everyMs = Math.max(1, Number(minutes)) * 60000;
    if (loop.timer) { clearInterval(loop.timer); loop.timer = null; }
    if (loop.on) {
      loop.timer = setInterval(async () => {
        if (!alive()) { clearInterval(loop.timer); return; }
        if (state.running) return;
        const sw = await shiftWindow();
        if (!sw.ok) return;                       // вне смены молчим, без шума в журнал
        autopilot(Number($('.ja-limit').value) || 0, true);
      }, loop.everyMs);
    }
    chrome.storage.local.set({ loopOn: loop.on, loopMin: Math.round(loop.everyMs / 60000) });
  }

  // ---------- выгрузка журнала ----------

  async function exportJournal() {
    const { journal = [] } = await chrome.storage.local.get(['journal']);
    if (!journal.length) return log('журнал пуст');

    const byAction = {};
    const blocks = {};
    const gaps = {};
    const reasons = {};
    const deliveries = {};
    const crmActions = {};
    let inTok = 0, outTok = 0, cacheTok = 0;

    for (const e of journal) {
      byAction[e.action] = (byAction[e.action] || 0) + 1;
      for (const b of (e.blocks || [])) blocks[b] = (blocks[b] || 0) + 1;
      if (e.gap) gaps[e.gap] = (gaps[e.gap] || 0) + 1;
      if (e.action === 'escalate' && e.topic) reasons[e.topic] = (reasons[e.topic] || 0) + 1;
      if (e.delivery) deliveries[e.delivery] = (deliveries[e.delivery] || 0) + 1;
      if (e.crmAction) crmActions[e.crmAction] = (crmActions[e.crmAction] || 0) + 1;
      if (e.usage) {
        inTok += e.usage.in || 0; outTok += e.usage.out || 0;
        cacheTok += (e.usage.cacheRead || 0) + (e.usage.cacheWrite || 0);
      }
    }

    const top = (o, n = 40) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, v]) => `${v}× ${k}`).join('\n');

    const out = [
      `ЖУРНАЛ SUPPORT ASSIST — ${new Date().toLocaleString('ru-RU')}`,
      `Записей: ${journal.length}`,
      '',
      '--- ИСХОДЫ ---',
      Object.entries(byAction).map(([k, v]) => `${v}× ${k}`).join('\n'),
      '',
      '--- ДЕЙСТВИЯ В CRM ---',
      top(crmActions),
      '',
      '--- ДОСТАВКА ---',
      top(deliveries),
      '',
      '--- ТОКЕНЫ ---',
      `вход ${inTok} · выход ${outTok} · кэш ${cacheTok}`,
      '',
      '--- ПРИЧИНЫ ЭСКАЛАЦИИ ---',
      top(reasons, 60),
      '',
      '--- ЧЕГО НЕ ХВАТИЛО В БАЗЕ ---',
      top(gaps, 60),
      '',
      '--- БЛОКИ ---',
      top(blocks, 200),
      '',
      '--- ВСЕ ЗАПИСИ ---',
      ...journal.map((e) => {
        const head = `${new Date(e.ts).toLocaleString('ru-RU')} | #${e.ticket || '—'} | ${e.client || '—'}`
          + ` | ${e.action} | канал: ${e.channel || '—'} | этап: ${e.stage || '—'}`
          + (e.crmAction ? ` | действие: ${e.crmAction}` : '')
          + (e.delivery ? ` | доставка: ${e.delivery}` : '')
          + (e.blocks?.length ? ` | блоки: ${e.blocks.join(', ')}` : '')
          + (e.reason ? ` | причина: ${e.reason}` : '');
        return `${head}\n  В: ${(e.question || '').slice(0, 300)}\n  О: ${(e.answer || '—').slice(0, 300)}`;
      }),
    ].join('\n');

    const blob = new Blob([out], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cmp-journal-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    log(`журнал выгружен: ${journal.length} записей`);
  }

  // ---------- панель ----------

  const ui = document.createElement('div');
  ui.id = 'cmp-assist';
  ui.innerHTML = `
    <div class="ja-bar">
      <span class="ja-title">Support Assist</span>
      <label class="ja-auto"><input type="checkbox" class="ja-autochk"> авто</label>
      <button class="ja-min" title="Свернуть">–</button>
    </div>
    <div class="ja-body">
      <button class="ja-run">Разобрать это обращение</button>
      <div class="ja-pilot">
        <button class="ja-auto-run">Автопилот</button>
        <label title="0 — пока не кончится очередь">лимит <input class="ja-limit" type="number" min="0" max="200" value="10"></label>
      </div>
      <label class="ja-loop"><input type="checkbox" class="ja-loopchk"> работать постоянно
        <input class="ja-loopmin" type="number" min="1" max="120" value="10"> мин</label>
      <label class="ja-loop ja-outage"><input type="checkbox" class="ja-outchk"> 🔴 режим аварии</label>
      <button class="ja-diag">Диагностика</button>
      <button class="ja-journal">Выгрузить журнал</button>
      <button class="ja-reset">Очистить журнал</button>
      <div class="ja-draft" hidden>
        <div class="ja-meta"></div>
        <textarea class="ja-text" rows="6" aria-label="Черновик ответа"></textarea>
        <div class="ja-actions">
          <button class="ja-send">Отправить</button>
          <button class="ja-skip">Пропустить</button>
        </div>
      </div>
      <div class="ja-log" aria-live="polite"></div>
    </div>`;

  const css = document.createElement('style');
  css.textContent = `
    #cmp-assist{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:360px;
      background:одно обращение1a;color:#e6e8eb;border:1px solid #2b2f36;border-radius:10px;
      font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 8px 28px rgba(0,0,0,.45);overflow:hidden}
    #cmp-assist .ja-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1b1e24;border-bottom:1px solid #2b2f36}
    #cmp-assist .ja-title{flex:1;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#9aa3ad}
    #cmp-assist .ja-auto{display:flex;align-items:center;gap:4px;color:#9aa3ad;cursor:pointer;font-size:11px}
    #cmp-assist .ja-min{background:none;border:1px solid одно обращениеb44;color:#9aa3ad;width:20px;height:20px;border-radius:4px;cursor:pointer;line-height:1}
    #cmp-assist.collapsed .ja-body{display:none}
    #cmp-assist .ja-body{padding:10px}
    #cmp-assist button{font:inherit;cursor:pointer;border-radius:6px;padding:7px 9px;
      background:одно обращение2c;color:#e6e8eb;border:1px solid одно обращение42}
    #cmp-assist button:hover{background:#2a2f38}
    #cmp-assist button:focus-visible{outline:2px solid #6ea8fe;outline-offset:1px}
    #cmp-assist .ja-run{width:100%}
    #cmp-assist .ja-loop{display:flex;align-items:center;gap:5px;margin-top:8px;color:#9aa3ad;font-size:11px}
    #cmp-assist .ja-outage:has(.ja-outchk:checked){color:#ff8080;font-weight:600}
    #cmp-assist .ja-loopmin{width:42px;background:#0f1114;color:#e6e8eb;border:1px solid одно обращение42;border-radius:5px;padding:4px;font:inherit}
    #cmp-assist .ja-diag,#cmp-assist .ja-journal{width:100%;margin-top:6px;color:#9aa3ad}
    #cmp-assist .ja-reset{width:100%;margin-top:6px;color:#c98a6b;border-color:#5a3a2c}
    #cmp-assist .ja-pilot{display:flex;gap:6px;align-items:center;margin-top:6px}
    #cmp-assist .ja-auto-run{flex:1;border-color:#3a4a6b;color:#9dc0ff}
    #cmp-assist .ja-pilot label{color:#6b7480;font-size:11px;display:flex;align-items:center;gap:4px}
    #cmp-assist .ja-limit{width:46px;background:#0f1114;color:#e6e8eb;border:1px solid одно обращение42;border-radius:5px;padding:5px;font:inherit}
    #cmp-assist .ja-draft{margin-top:10px}
    #cmp-assist .ja-meta{color:#9aa3ad;margin-bottom:6px}
    #cmp-assist .ja-text{width:100%;box-sizing:border-box;background:#0f1114;color:#e6e8eb;
      border:1px solid одно обращение42;border-radius:6px;padding:8px;font:inherit;resize:vertical}
    #cmp-assist .ja-actions{display:flex;gap:6px;margin-top:6px}
    #cmp-assist .ja-send{flex:1;border-color:#2f5d3a;color:#8ee6a8}
    #cmp-assist .ja-log{margin-top:10px;max-height:160px;overflow:auto;border-top:1px solid #2b2f36;padding-top:8px}
    #cmp-assist .ja-row{margin-bottom:6px;word-break:break-word}
    #cmp-assist .ja-row b{color:#9aa3ad;font-weight:400}
    #cmp-assist .err{color:#f87171}
    #cmp-assist .ja-dim{color:#6b7480}
    #cmp-assist .ja-w2{color:#f0ad4e}
  `;

  const $ = (s) => ui.querySelector(s);
  const log = (html, cls = '') => {
    const d = document.createElement('div');
    d.className = 'ja-row ' + cls;
    d.innerHTML = html;
    $('.ja-log').prepend(d);
  };

  let pending = null;
  let override = { id: null, until: 0 };

  async function analyse() {
    const id = ticketId();
    if (!id) return log('Откройте обращение', 'err');
    await scrollHistoryToEnd();
    const last = lastFromClient();
    if (!last) {
      return log(crmWantsAnswer() === true
        ? 'Этап «Нужен ответ», но реплики клиента не видно — проверьте ленту вручную'
        : 'Клиент не писал последним — разбирать нечего', crmWantsAnswer() === true ? 'err' : '');
    }

    const forced = override.id === id && Date.now() < override.until;
    if (!forced) {
      const locked = await lockReason(id, last);
      if (locked) {
        override = { id, until: Date.now() + 30000 };
        return log(`<b>${locked}.</b> Нажмите ещё раз в течение 30 секунд, чтобы разобрать всё равно`);
      }
    }
    override = { id: null, until: 0 };

    // «Стоп» поднимает флаг остановки, а снимался он только при следующем
    // запуске автопилота. Из-за этого после одного нажатия «Стоп» ручная
    // отправка навсегда падала с «остановлено оператором».
    //
    // Ручное действие — это и есть команда работать: снимаем флаг здесь.
    state.abort = false;

    // Те же две развилки, что в автопилоте. Раньше их тут не было: ручной
    // разбор шёл прямо к модели, и на «Всё, уже разобралась)) Благодарю»
    // модель отвечать было нечем — обращение уходило в эскалацию как
    // нерешённое (было в работе). Спрашивать модель про закрытие
    // незачем: и признак, и фраза здесь пишутся кодом.
    const done = (CANCELLED.test(last) && last.length < 120) || thanksOnly(last) || solvedOnly(last);
    if (done) {
      const { closeSilent: cs = false } = await chrome.storage.local.get(['closeSilent']);
      const bye = cs ? '' : await closingPhrase(id, confirmedFixed(last));
      pending = { id, message: bye, crmAction: closeAction() };
      $('.ja-meta').textContent = `клиент снял вопрос · действие: ${pending.crmAction}`;
      $('.ja-text').value = bye;
      $('.ja-draft').hidden = false;
      if ($('.ja-autochk').checked) {
        if (bye) await humanPause(bye);
        const r = await sendReply(bye, pending.crmAction);
        $('.ja-draft').hidden = true;
        pending = null;
        log(r.ok ? '<b>закрыто</b>' : '<b>доставка не прошла</b>', r.ok ? '' : 'err');
      }
      return;
    }

    $('.ja-run').disabled = true;
    log('Думаю…');
    try {
      const shot = await grabLastImage();
      const image = shot.image;
      const { d } = await askModel({
        history: history() + shotNote(shot), account: null, clientName: clientName(), last,
        image, sent: await sentBlocks(id), did: operatorDid(),
      });
      pending = { ...d, id };
      await record({ ticket: id, client: clientName(), channel: channel(), stage: stage().key,
                     action: d.action, question: last, answer: d.message, topic: d.topic,
                     reason: d.reason, gap: d.gap, draftBlocks: d.blocks, src: 'Вручную',
                     provider: d.provider, model: d.model, usage: d.usage });

      if (d.action === 'escalate') {
        $('.ja-draft').hidden = true;
        log(`<b>эскалация:</b> ${d.reason}`);
        log(`<span class="ja-dim">${escalationNote(d, last).replace(/\n/g, '<br>')}</span>`);
      } else if (!String(d.message || '').trim()) {
        $('.ja-draft').hidden = true;
        log('модель вернула пустой ответ');
      } else {
        const act = confirmedFixed(last) ? ACT.close : ACT.reply;
        pending.crmAction = act;
        $('.ja-meta').textContent = `тема: ${d.topic || '—'} · действие: ${act}`;
        $('.ja-text').value = d.message;
        $('.ja-draft').hidden = false;
        if ($('.ja-autochk').checked) {
          await humanPause(d.message);
          const r = await sendReply(d.message, act);
          $('.ja-draft').hidden = true;
          log(r.ok ? '<b>отправлено</b>' : '<b>доставка не прошла</b>', r.ok ? '' : 'err');
        }
      }
    } catch (e) {
      log('Ошибка: ' + e.message, 'err');
      await recordError('разбор обращения', e.message, clientName());
    } finally {
      $('.ja-run').disabled = false;
    }
  }

  $('.ja-run').addEventListener('click', analyse);

  $('.ja-send').addEventListener('click', async () => {
    if (!pending) return;
    state.abort = false;        // см. комментарий в analyse()
    try {
      const r = await sendReply($('.ja-text').value, pending.crmAction || ACT.reply);
      $('.ja-draft').hidden = true;
      log(r.ok ? '<b>отправлено</b>' : '<b>доставка не прошла</b>', r.ok ? '' : 'err');
      pending = null;
    } catch (e) { log('Ошибка отправки: ' + e.message, 'err'); }
  });

  $('.ja-skip').addEventListener('click', () => { $('.ja-draft').hidden = true; pending = null; });

  $('.ja-auto-run').addEventListener('click', () => {
    if (state.running) {
      state.stop = true;
      state.abort = true;
      log('стоп');
      // Флаг живёт только до конца текущего прогона: через пару секунд
      // цикл его увидит и завершится, дальше он только мешает.
      setTimeout(() => { if (!state.running) state.abort = false; }, 4000);
      return;
    }
    autopilot(Math.max(0, Number($('.ja-limit').value) || 0));
  });

  $('.ja-diag').addEventListener('click', async () => {
    const n = (s) => document.querySelectorAll(s).length;
    const rows = listRows();
    const card = readCard();
    const sw = await shiftWindow();
    const acts = actionButtons().map((b) => normAction(txt(b)));
    log([
      `проект: ${currentProject() || '—'} · диалога: ${dialogProject() || '—'}`,
      `строк очереди: ${rows.length}${rows.length ? ` · первая #${rows[0].id} ${rows[0].name}` : ''}`,
      'папки: ' + ['Входящие вам', 'Переданные вам', 'Общие входящие', 'Просроченные', 'Ночные']
        .map((f) => `${f} ${folderCount(f) ?? '—'}`).join(' · '),
      `обращение: ${ticketId() || '—'} · этап: ${stage().label || '—'} (${stage().key || '—'})`,
      `срок: ${deadlineSecs() === null ? 'нет таймера' : deadlineSecs() + 'с'} · нагрузка ×${loadMultiplier()}`,
      `сообщений: ${n(S.msgRow)} · поле ответа: ${n(S.textarea)} · кнопка отправки: ${n(S.sendBtn)}`,
      `кнопки действий: ${acts.length ? acts.join(' | ') : '—'}`,
      // Кто написал каждую строку. «другое» больше нуля означает, что CRM
      // переименовала классы incoming/outgoing и бот перестал различать
      // клиента и сотрудника — именно так выглядит «читает и не отвечает».
      (() => {
        const rr = messageRows();
        const c = { client: 0, operator: 0, auto: 0, other: 0 };
        rr.forEach((r) => { c[rowKind(r)]++; });
        const tail = rr.slice(-3).map((r) =>
          `${rowKind(r)}@${rowTime(r) || '?'}: ${rowText(r).replace(/\s+/g, ' ').slice(0, 30) || '(пусто)'}`);
        return `лента: клиент ${c.client} · сотрудник ${c.operator} · автоответ ${c.auto} · другое ${c.other}`
          + (c.other ? ' ← классы строк изменились' : '')
          + (tail.length ? `<br>хвост: ${tail.join(' | ')}` : '');
      })(),
      `канал: ${channel() || '—'} · ответственный: ${card['Ответственный'] || '—'}`,
      `последняя реплика клиента: ${(lastFromClient() || '—').slice(0, 70)}`,
      `смена: ${sw.ok ? 'в окне' : sw.note}`,
      `перехват диалогов: ${document.documentElement.getAttribute('data-cmp-hook') === '1' ? 'да' : 'НЕТ — бот встанет на закрытии'}`,
    ].join('<br>'));
  });

  $('.ja-journal').addEventListener('click', exportJournal);

  $('.ja-reset').addEventListener('click', async () => {
    await chrome.storage.local.set({ journal: [], locks: {} });
    log('журнал и замки очищены');
  });

  $('.ja-min').addEventListener('click', () => ui.classList.toggle('collapsed'));

  $('.ja-loopchk').addEventListener('change', (e) => {
    setLoop(e.target.checked, Number($('.ja-loopmin').value) || 10);
    log(e.target.checked
      ? `постоянный режим: каждые ${Number($('.ja-loopmin').value) || 10} мин`
      : 'постоянный режим выключен');
  });

  $('.ja-outchk').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await chrome.storage.local.set({ outage: on });
    if (on) {
      const { outageText = '' } = await chrome.storage.local.get(['outageText']);
      log(outageText.trim()
        ? '<b>режим аварии ВКЛЮЧЁН</b> — не забудьте выключить'
        : '<b>режим аварии включён, но текст объявления пуст</b> — впишите его в настройках',
        outageText.trim() ? '' : 'err');
    } else log('<b>режим аварии выключен</b>');
  });

  // ---------- команды из Telegram ----------

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type === 'remoteRun') {
      const limit = Math.max(0, Number(msg.limit) || 0);
      $('.ja-limit').value = limit;
      autopilot(limit, true);
      respond({ started: true });
    } else if (msg.type === 'remoteStop') {
      state.stop = true; state.abort = true;
      respond({ stopping: true });
    } else if (msg.type === 'remoteStatus') {
      respond({
        running: state.running, loop: loop.on,
        everyMin: Math.round(loop.everyMs / 60000),
        project: currentProject(), mode: loadMultiplier(),
        queue: folderCount('Общие входящие'),
        overdue: folderCount('Просроченные'),
        ...state.stats,
      });
    } else if (msg.type === 'remoteLoop') {
      setLoop(msg.on, msg.minutes);
      respond({ loop: loop.on, everyMin: Math.round(loop.everyMs / 60000) });
    } else {
      respond({ ok: true });
    }
    return true;
  });

  // ---------- старт ----------

  (async () => {
    const s = await chrome.storage.local.get(['outage', 'loopOn', 'loopMin', 'project']);
    $('.ja-outchk').checked = !!s.outage;
    if (s.loopMin) $('.ja-loopmin').value = s.loopMin;
    if (s.loopOn) { $('.ja-loopchk').checked = true; setLoop(true, s.loopMin || 10); }

    // Проверка разметки при запуске. Если CRM обновилась и селекторы отвалились,
    // бот должен сказать об этом сразу, а не отвечать вслепую.
    await wait(2500);
    const miss = [];
    if (!document.querySelector(S.projectBtns)) miss.push('переключатель проектов');
    if (!document.querySelector(S.folders)) miss.push('папки обращений');
    // Кнопки действий проверяем только когда открыт диалог: на списке их нет.
    if (document.querySelector(S.composer) && !actionButtons().length) {
      miss.push('кнопки действий в композере');
    }

    // Перехватчик диалогов. Без него бот встанет на первом же закрытии
    // обращения и будет ждать, пока кто-то нажмёт «ОК».
    if (document.documentElement.getAttribute('data-cmp-hook') !== '1') {
      log('<b>page-hook.js не загрузился</b> — CRM будет ждать подтверждения при закрытии. Проверьте, что файл лежит рядом с content.js, и обновите расширение.', 'err');
      send('report', { text: '⚠️ Support Assist: page-hook.js не загрузился, бот встанет на подтверждении закрытия' }).catch(() => {});
    }
    if (miss.length) {
      log(`<b>разметка не найдена:</b> ${miss.join(', ')} — CRM обновилась?`, 'err');
      send('report', { text: `⚠️ Support Assist: не найдена разметка — ${miss.join(', ')}` }).catch(() => {});
    } else {
      log(`<span class="ja-dim">готов · проект ${currentProject() || '—'} · нагрузка ×${loadMultiplier()}</span>`);
    }
  })();

  document.documentElement.appendChild(css);
  document.documentElement.appendChild(ui);
})();
