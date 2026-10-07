/**
 * HTML for the mock's frames and identity check page. Plain pages, no inline
 * script (the CSP is default-src 'self'), every dynamic value set through
 * textContent. Perflo's mark appears only here, inside the frames.
 */

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export interface FrameIds {
  loginId: string | null;
  topUpId: string | null;
  orderId: string | null;
}

export function framePage(partnerOrigin: string, ids: FrameIds): string {
  return `<!doctype html>
<html lang="en" data-partner-origin="${escapeHtml(partnerOrigin)}" data-login-id="${escapeHtml(ids.loginId ?? '')}" data-top-up-id="${escapeHtml(ids.topUpId ?? '')}" data-order-id="${escapeHtml(ids.orderId ?? '')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payments</title>
<link rel="stylesheet" href="/mock-assets/frame.css">
</head>
<body>
<main id="app" aria-live="polite"><p class="muted">Loading...</p></main>
<footer>Secured by <strong>Perflo</strong> <span class="badge">Test mode</span></footer>
<script src="/mock-assets/frame.js"></script>
</body>
</html>`;
}

export function kycPage(state: 'start' | 'done' | 'missing', ref: string): string {
  const body =
    state === 'missing'
      ? '<h1>This link is not valid</h1><p>Go back to Tiny and try again.</p>'
      : state === 'done'
        ? '<h1>You are verified</h1><p>Thanks. You can close this tab and go back to Tiny.</p>'
        : `<h1>Verify your identity</h1>
<p>Your orders are now over $200 in total, so we need to confirm it is really you. This only happens once.</p>
<p class="muted">Test mode: no documents are needed.</p>
<form method="post" action="/mock/kyc"><input type="hidden" name="ref" value="${escapeHtml(ref)}"><button type="submit">Finish identity check</button></form>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Identity check</title><link rel="stylesheet" href="/mock-assets/frame.css"></head>
<body><main class="page">${body}</main><footer>Secured by <strong>Perflo</strong> <span class="badge">Test mode</span></footer></body></html>`;
}

const css = `
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:#141414;font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{padding:20px 20px 8px;max-width:440px;margin:0 auto}
main.page{padding-top:48px}
h1{font-size:20px;margin:0 0 6px;font-weight:650}
p{margin:0 0 12px}
.muted{color:#6b655f;font-size:13px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.brand{font-weight:700;letter-spacing:-.01em}
.close{border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:#6b655f;width:44px;height:44px}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px;color:#3d3935}
input[type=text],input[type=email]{width:100%;height:46px;border:1px solid #d9d4ce;border-radius:12px;padding:0 14px;font:inherit}
input:focus-visible,button:focus-visible{outline:2px solid #141414;outline-offset:2px}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{height:40px;padding:0 14px;border-radius:20px;border:1px solid #d9d4ce;background:#fff;font:inherit;cursor:pointer}
.chip[aria-pressed=true]{background:#141414;color:#fff;border-color:#141414}
button.primary,form button{width:100%;height:48px;border:0;border-radius:12px;background:#141414;color:#fff;font:inherit;font-weight:600;margin-top:18px;cursor:pointer}
button.primary:disabled{opacity:.4;cursor:not-allowed}
button.link{border:0;background:none;color:#141414;text-decoration:underline;font:inherit;font-size:13px;padding:8px 0;cursor:pointer}
.box{border:1px solid #e8e4df;border-radius:14px;padding:14px;margin-top:12px}
.error{color:#a3261b;font-size:14px;margin-top:10px}
footer{text-align:center;font-size:12px;color:#6b655f;padding:12px 0 18px}
.mt{margin-top:8px}
.badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;background:#f4f2ef;font-size:11px}
`;

const js = String.raw`(function () {
  'use strict';
  var partnerOrigin = document.documentElement.getAttribute('data-partner-origin');
  var session = new URLSearchParams(location.search).get('session') || '';
  var app = document.getElementById('app');
  var root = document.documentElement;
  var ids = {
    login_id: root.getAttribute('data-login-id') || undefined,
    top_up_id: root.getAttribute('data-top-up-id') || undefined,
    order_id: root.getAttribute('data-order-id') || undefined
  };
  var state = null;
  var typedEmail = '';

  function send(type, extra) {
    var message = { type: type, frame_session_id: session };
    if (extra) Object.keys(extra).forEach(function (k) { if (extra[k]) message[k] = extra[k]; });
    window.parent.postMessage(message, partnerOrigin);
  }

  function call(path, body) {
    var init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch('/partner/v2/frames/' + encodeURIComponent(session) + '/' + path, init).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        if (!res.ok) {
          var error = new Error((json && json.error && json.error.message) || 'Something went wrong. Try again.');
          error.code = (json && json.error && json.error.code) || 'unknown';
          throw error;
        }
        return json;
      });
    });
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') node.textContent = props[k];
      else if (k === 'on') Object.keys(props.on).forEach(function (e) { node.addEventListener(e, props.on[e]); });
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function money(amount) {
    var parts = String(amount).split('.');
    return '$' + Number(parts[0]).toLocaleString('en-US') + '.' + (parts[1] || '00');
  }

  function toAmount(text) {
    var cleaned = String(text).replace(/[$,\s]/g, '');
    if (!/^[0-9]{1,7}(\.[0-9]{1,2})?$/.test(cleaned)) return null;
    var p = cleaned.split('.');
    var value = p[0].replace(/^0+(?=[0-9])/, '') + '.' + ((p[1] || '') + '00').slice(0, 2);
    return value === '0.00' ? null : value;
  }

  function screen(title, lines, content) {
    app.textContent = '';
    var top = el('div', { class: 'top' }, [
      el('span', { class: 'brand', text: state && state.partner && state.partner.brand ? state.partner.brand.name : '' }),
      el('button', { class: 'close', 'aria-label': 'Close', text: '×', on: { click: function () { send('perflo:closed'); } } })
    ]);
    app.appendChild(top);
    app.appendChild(el('h1', { text: title }));
    (lines || []).forEach(function (line) { app.appendChild(el('p', { class: line.muted ? 'muted' : '', text: line.text || line })); });
    (content || []).forEach(function (c) { app.appendChild(c); });
  }

  function showError(error) {
    var old = app.querySelector('.error');
    if (old) old.remove();
    app.appendChild(el('p', { class: 'error', role: 'alert', text: error.message }));
    send('perflo:error', { code: error.code || 'unknown' });
  }

  function busy(button, on, label) {
    button.disabled = on;
    if (label) button.textContent = label;
  }

  function render() {
    if (state.step === 'login') return renderLogin();
    if (state.step === 'limits') return renderLimits();
    if (state.step === 'top_up') return renderTopUp();
    return renderDone();
  }

  function renderLogin() {
    if (!state.email_masked && !typedEmail) {
      var email = el('input', { type: 'email', id: 'email', autocomplete: 'email', required: 'required' });
      var next = el('button', { class: 'primary', text: 'Send code', on: { click: function () {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) return showError({ message: 'Enter a valid email address.', code: 'email_invalid' });
        typedEmail = email.value.trim();
        renderLogin();
      } } });
      return screen('Set up payments', ['One time. After this, Tiny pays for orders without sending you links.'], [
        el('label', { for: 'email', text: 'Your email' }), email, next
      ]);
    }
    var target = state.email_masked || typedEmail;
    var code = el('input', { type: 'text', id: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6' });
    var verify = el('button', { class: 'primary', text: 'Verify' });
    verify.addEventListener('click', function () {
      if (!/^[0-9]{6}$/.test(code.value.trim())) return showError({ message: 'Enter the 6-digit code.', code: 'code_format' });
      busy(verify, true, 'Checking...');
      var token = 'mock-otp:' + (typedEmail ? typedEmail + ':' : '') + code.value.trim();
      call('login', { privy_access_token: token }).then(function (result) {
        send('perflo:login_completed', { login_id: ids.login_id });
        state.step = result.next;
        render();
      }).catch(function (error) { busy(verify, false, 'Verify'); showError(error); });
    });
    var resend = el('button', { class: 'link', text: 'Send a new code', on: { click: function () { resend.textContent = 'We sent a new code.'; } } });
    screen('Enter your code', [
      'We sent a 6-digit code to ' + target + '.',
      { text: 'Test mode: the code is 123456.', muted: true }
    ], [el('label', { for: 'code', text: '6-digit code' }), code, verify, resend]);
    code.focus();
  }

  function chooser(id, label, presets) {
    var chosen = { value: null };
    var other = el('input', { type: 'text', inputmode: 'decimal', id: id, placeholder: 'Other amount', 'aria-label': label + ', other amount' });
    var chips = presets.map(function (p) {
      return el('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', text: money(p), on: { click: function (event) {
        chips.forEach(function (c) { c.setAttribute('aria-pressed', 'false'); });
        event.currentTarget.setAttribute('aria-pressed', 'true');
        other.value = '';
        chosen.value = p;
        chosen.onchange && chosen.onchange();
      } } });
    });
    other.addEventListener('input', function () {
      chips.forEach(function (c) { c.setAttribute('aria-pressed', 'false'); });
      chosen.value = toAmount(other.value);
      chosen.onchange && chosen.onchange();
    });
    chosen.nodes = [el('label', { text: label }), el('div', { class: 'chips' }, chips), el('div', { class: 'mt' }, [other])];
    return chosen;
  }

  function renderLimits() {
    var perOrder = chooser('per-order', 'Per order, up to', ['500.00', '1000.00', '2500.00']);
    var perMonth = chooser('per-month', 'Per month, up to', ['1000.00', '3000.00', '5000.00']);
    var setup = state.purpose === 'setup';
    var save = el('button', { class: 'primary', text: setup ? 'Allow Tiny' : 'Save limits', disabled: 'disabled' });
    perOrder.onchange = perMonth.onchange = function () { save.disabled = !(perOrder.value && perMonth.value); };
    save.addEventListener('click', function () {
      busy(save, true);
      call('limits', { per_order: perOrder.value, per_month: perMonth.value }).then(function (result) {
        send('perflo:limits_saved', {});
        state.step = result.next;
        render();
      }).catch(function (error) { busy(save, false); showError(error); });
    });
    screen(setup ? 'Allow Tiny to pay for you' : 'Change your limits', [
      'Tiny can pay for orders and services for you, within the limits below.'
    ], perOrder.nodes.concat(perMonth.nodes, [save, el('p', { class: 'muted', text: 'You can change these limits anytime.' })]));
  }

  function renderTopUp() {
    var forOrder = state.order ? 'For your order at ' + state.order.merchant.domain + ' (' + money(state.order.amount) + ').' : null;
    var needs = state.amount && state.order ? 'This order needs ' + money(state.amount) + ', including fees.' : null;
    var input = el('input', { type: 'text', inputmode: 'decimal', id: 'amount', value: state.amount || '' });
    var presets = state.order ? [] : ['100.00', '250.00', '500.00'].map(function (p) {
      return el('button', { class: 'chip', type: 'button', text: money(p), on: { click: function () { input.value = p; } } });
    });
    var next = el('button', { class: 'primary', text: 'Continue' });
    next.addEventListener('click', function () {
      var amount = toAmount(input.value);
      if (!amount) return showError({ message: 'Enter an amount.', code: 'amount_invalid' });
      busy(next, true);
      call('top-up', { amount: amount }).then(function (result) {
        ids.top_up_id = result.top_up_id;
        renderPay(result);
      }).catch(function (error) { busy(next, false); showError(error); });
    });
    screen('Add money', [forOrder, needs].filter(Boolean), [
      el('label', { for: 'amount', text: 'Amount in US dollars' }), input,
      presets.length ? el('div', { class: 'chips mt' }, presets) : null, next
    ]);
  }

  function renderPay(topUp) {
    var pay = el('button', { class: 'primary', text: 'Pay ' + money(topUp.amount) });
    pay.addEventListener('click', function () {
      busy(pay, true, 'Paying...');
      fetch('/mock-stripe/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_secret: topUp.client_secret }) })
        .then(function (res) { if (!res.ok) throw new Error('The payment did not go through. Try again.'); return call('complete', { step: 'top_up' }); })
        .then(function () {
          send('perflo:top_up_completed', { top_up_id: topUp.top_up_id, order_id: ids.order_id });
          if (state.purpose === 'setup') return finishSetup();
          state.step = 'done';
          render();
        })
        .catch(function (error) { busy(pay, false, 'Pay ' + money(topUp.amount)); showError(error); });
    });
    screen('Add money', ['Adding ' + money(topUp.amount) + ' to your balance.'], [
      el('div', { class: 'box' }, [
        el('p', { text: 'Test payment' }),
        el('p', { class: 'muted', text: 'No real card is charged in test mode.' })
      ]),
      pay
    ]);
  }

  function finishSetup() {
    return call('complete', { step: 'setup' }).then(function () {
      send('perflo:setup_completed', { login_id: ids.login_id });
      state.step = 'done';
      state.finished = true;
      render();
    }).catch(showError);
  }

  function renderDone() {
    if (state.purpose === 'setup' && !state.finished) return finishSetup();
    var title = state.purpose === 'limits' ? 'Limits saved' : state.purpose === 'top-up' ? 'Money added' : 'You are all set';
    screen(title, ['You can go back to Tiny.'], []);
  }

  if (!session) { app.textContent = 'This link is not valid.'; return; }
  call('state').then(function (result) {
    state = result;
    // A setup that already reached the end shows the end, without sending events again.
    if (state.purpose === 'setup' && state.step === 'done') { state.finished = true; }
    send('perflo:ready', ids);
    render();
  }).catch(function (error) {
    app.textContent = '';
    app.appendChild(el('h1', { text: 'This link cannot be used' }));
    app.appendChild(el('p', { text: error.message }));
    send('perflo:error', { code: error.code || 'unknown' });
  });
})();`;

export const frameAssets: Record<string, { type: string; body: string }> = {
  'frame.css': { type: 'text/css', body: css },
  'frame.js': { type: 'application/javascript', body: js },
};
