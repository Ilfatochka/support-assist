// Текстовые и числовые поля.
const FIELDS = [
  'project', 'folders', 'myName', 'shiftFrom', 'shiftTo',
  'escalateMode', 'pauseMin', 'pauseMax', 'slaGuard', 'dayLimit', 'vpnTimeout', 'sendWait',
  'systemPrompt', 'minBlocks',
  'diKey', 'diModel', 'apiKey', 'model',
  'outageText', 'outageDays', 'knownIssues', 'stopWords', 'denyList', 'closeText', 'closeTextOk', 'holdText',
  'tgToken', 'tgChatId', 'failAlert',
];

// Галочки, выключенные по умолчанию.
const CHECKS = ['outage', 'useDeepInfra', 'tgControl', 'heartbeat', 'closeSilent'];

// Галочки, включённые по умолчанию: обычные стартуют выключенными.
const CHECKS_ON = ['twoStep', 'waitingPing', 'useVpnPanel'];

// Значения по умолчанию для полей, где пустота опасна. Промпт и ключи
// сюда не попадают: их пустота должна быть видна, а не подменена.
const FALLBACK = {
  project: 'VPN',
  folders: 'Входящие вам\nПереданные вам\nОбщие входящие',
  escalateMode: 'hold',
  minBlocks: '90',
  slaGuard: '45',
  vpnTimeout: '75',
  sendWait: '30',
};

chrome.storage.local.get([...FIELDS, ...CHECKS, ...CHECKS_ON]).then((s) => {
  FIELDS.forEach((k) => {
    const el = document.getElementById(k);
    if (!el) return;
    const v = s[k] !== undefined && s[k] !== '' ? s[k] : (FALLBACK[k] ?? '');
    if (v !== '') el.value = v;
  });
  CHECKS.forEach((k) => { const el = document.getElementById(k); if (el) el.checked = !!s[k]; });
  CHECKS_ON.forEach((k) => { const el = document.getElementById(k); if (el) el.checked = s[k] !== false; });
});

document.getElementById('save').addEventListener('click', async () => {
  const data = {};
  FIELDS.forEach((k) => {
    const el = document.getElementById(k);
    if (el) data[k] = String(el.value ?? '').trim();
  });
  CHECKS.forEach((k) => { const el = document.getElementById(k); if (el) data[k] = el.checked; });
  CHECKS_ON.forEach((k) => { const el = document.getElementById(k); if (el) data[k] = el.checked; });

  await chrome.storage.local.set(data);

  const s = document.getElementById('status');
  const box = document.getElementById('diag');

  // Сразу считаем блоки в базе: если промпт снова обрезался при вставке,
  // узнать об этом надо здесь, а не через час на живых клиентах.
  // Тот же разбор, что в background.js: считаем закрытые блоки, а не заголовки.
  const BLOCK_RE = /^###\s*БЛОК:\s*([A-Z0-9_]+)\s*$([\s\S]*?)^###\s*КОНЕЦ БЛОКА\s*$/gmi;
  const blocks = (String(data.systemPrompt || '').match(BLOCK_RE) || []).length;
  const heads = (String(data.systemPrompt || '').match(/^###\s*БЛОК:/gmi) || []).length;
  const min = parseInt(data.minBlocks, 10) || 0;

  const notes = [];
  notes.push(`длина базы: ${String(data.systemPrompt || '').length} знаков`);
  notes.push(`блоков найдено: ${blocks}${min ? ` (порог ${min})` : ''}`);
  if (heads > blocks) {
    notes.push(`⚠️ незакрытых блоков: ${heads - blocks} — база оборвана или потерян «### КОНЕЦ БЛОКА»`);
  }
  if (min && blocks && blocks < min) {
    notes.push('⚠️ блоков меньше порога — бот не запустится, вставьте промпт целиком');
  }
  if (!data.apiKey) notes.push('⚠️ запасной ключ Anthropic не задан — при сбое DeepInfra бот встанет молча');
  if (!data.project) notes.push('⚠️ проект не задан — бот будет отвечать во всех брендах');
  if (data.outage && !data.outageText) notes.push('⚠️ режим аварии включён, но текст объявления пуст');

  box.textContent = notes.join('\n');
  s.textContent = 'сохранено';
  setTimeout(() => { s.textContent = ''; }, 1800);
});

document.getElementById('check').addEventListener('click', () => {
  const box = document.getElementById('diag');
  box.textContent = 'проверяю…';
  chrome.runtime.sendMessage({ type: 'tgDiagnose' }, (r) => {
    box.textContent = r?.ok ? r.data : ('ошибка: ' + (r?.error || 'нет ответа'));
  });
});
