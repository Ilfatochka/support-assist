// Работает в контексте самой страницы (world: MAIN), а не в песочнице
// расширения. Только ради одного: CRM показывает нативный confirm()
// при «Ответ не требуется» и «Решено · закрыть» —
//
//   «Подтвердить, что обращение не требует ответа?
//    Решение попадёт в историю и на проверку.»
//
// Нативный диалог останавливает весь JavaScript страницы и ждёт человека.
// Пока никто не нажмёт «ОК», бот стоит — а если оператор ушёл, стоит до
// его возвращения. однажды так встала вся очередь.
//
// Перехватить его из контент-скрипта нельзя: там своя копия window,
// и подмена confirm туда не достаёт. Отсюда отдельный файл.
//
// Подтверждаем НЕ всё подряд, а только то, что нажал сам бот: он ставит
// на <html> метку прямо перед кликом и снимает сразу после. Диалоги,
// вызванные руками оператора, ведут себя как обычно и спрашивают.

(() => {
  'use strict';
  if (window.__cmpPageHook) return;
  window.__cmpPageHook = true;

  const root = document.documentElement;
  const auto = () => root.getAttribute('data-cmp-auto') === '1';

  // Отметка для контент-скрипта: миры не видят переменных друг друга,
  // общий у них только DOM. Без этой проверки отсутствие перехватчика
  // обнаружилось бы первым зависшим диалогом.
  root.setAttribute('data-cmp-hook', '1');

  const origConfirm = window.confirm;
  window.confirm = function (...args) {
    if (auto()) return true;
    return origConfirm.apply(this, args);
  };

  const origAlert = window.alert;
  window.alert = function (...args) {
    // Уведомление тоже блокирует поток. Пока работает бот — глотаем его,
    // но оставляем след в консоли, чтобы текст не потерялся совсем.
    if (auto()) { try { console.log('[cmp-assist] alert подавлен:', args[0]); } catch (e) {} return; }
    return origAlert.apply(this, args);
  };

  const origPrompt = window.prompt;
  window.prompt = function (...args) {
    // На prompt осмысленного ответа у бота нет: подтверждать пустой строкой
    // опаснее, чем отменить. Отменяем — код увидит null и остановится сам.
    if (auto()) return null;
    return origPrompt.apply(this, args);
  };
})();
