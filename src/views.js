'use strict';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(price, currency = 'GBP') {
  if (price === undefined || price === null || price === '') return '';
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(Number(price)); }
  catch { return String(price); }
}

function productUrl(request, config) {
  if (request.source_url) return request.source_url;
  if (config.productUrlTemplate) return config.productUrlTemplate.replace('{sku}', encodeURIComponent(request.sku));
  return '';
}

const safeImage = (u) => (/^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? String(u) : '');

// ---------------------------------------------------------------- email

function renderEmail({ request, product, config }) {
  const name = (product && product.name) || request.sku;
  const price = product ? money(product.price, product.currency || 'GBP') : '';
  const image = safeImage(product && product.image);
  const url = productUrl(request, config);
  const low = product && product.quantity > 0 && product.quantity <= 10;
  const store = config.storeName;

  const subject = `Back in stock: ${name}`;
  const pre = low ? `Only ${product.quantity} left. You asked us to let you know.` : 'You asked us to let you know, so here it is.';

  const button = url
    ? `<tr><td style="padding:8px 32px 0">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
          <td align="center" bgcolor="#1f2a24" style="border-radius:8px">
            <a href="${esc(url)}" style="display:block;padding:15px 24px;font:600 16px/1.2 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:8px">Shop it now</a>
          </td></tr></table></td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>${esc(subject)}</title>
<style>
  @media (max-width:600px){ .wrap{width:100%!important} .px{padding-left:20px!important;padding-right:20px!important} .h1{font-size:24px!important} }
</style></head>
<body style="margin:0;padding:0;background:#f3f1ec;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(pre)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f1ec">
<tr><td align="center" style="padding:24px 12px">
  <table role="presentation" class="wrap" width="560" cellspacing="0" cellpadding="0" border="0" style="width:560px;max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
    <tr><td class="px" style="padding:22px 32px;border-bottom:1px solid #ebe8e1;font:600 14px/1.4 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2a24;letter-spacing:.02em">${esc(store)}</td></tr>
    <tr><td class="px" style="padding:28px 32px 6px">
      <span style="display:inline-block;padding:5px 10px;border-radius:999px;background:#e3efe6;color:#1d6b3a;font:600 12px/1 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.04em;text-transform:uppercase">Back in stock</span>
      <h1 class="h1" style="margin:16px 0 8px;font:700 28px/1.2 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2a24">It's back.</h1>
      <p style="margin:0;font:400 16px/1.55 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#4d554f">You asked us to email you when this was back in stock. It is, as of right now.</p>
    </td></tr>
    <tr><td class="px" style="padding:22px 32px 6px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #ebe8e1;border-radius:12px">
        <tr>
          ${image ? `<td width="112" style="padding:14px 0 14px 14px;vertical-align:top"><img src="${esc(image)}" width="96" height="96" alt="${esc(name)}" style="display:block;width:96px;height:96px;border-radius:8px;object-fit:cover;border:0"></td>` : ''}
          <td style="padding:16px;vertical-align:middle;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
            <div style="font:600 17px/1.35 inherit;color:#1f2a24">${esc(name)}</div>
            ${price ? `<div style="margin-top:4px;font:400 15px/1.4 inherit;color:#4d554f">${esc(price)}</div>` : ''}
            ${low ? `<div style="margin-top:8px;font:600 13px/1.4 inherit;color:#a14b16">Only ${esc(product.quantity)} left</div>` : ''}
            <div style="margin-top:6px;font:400 12px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#8a918b">SKU ${esc(request.sku)}</div>
          </td>
        </tr>
      </table>
    </td></tr>
    ${button}
    <tr><td class="px" style="padding:26px 32px 30px;font:400 13px/1.55 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#8a918b">
      Popular items can sell out again quickly. This is the only email you'll get about this item. You received it because ${esc(request.email)} signed up for a restock alert at ${esc(store)}.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = [
    `Back in stock: ${name}`,
    '',
    'You asked us to email you when this was back in stock. It is, as of right now.',
    price ? `Price: ${price}` : '',
    low ? `Only ${product.quantity} left.` : '',
    url ? `Shop it now: ${url}` : '',
    '',
    `This is the only email you'll get about this item. You received it because ${request.email} signed up for a restock alert at ${store}.`,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------- embed form

function renderEmbed({ sku, product, accent, inStock }) {
  const color = /^[0-9a-f]{6}$/i.test(accent || '') ? `#${accent}` : '#1f2a24';
  const name = product && product.name;
  const image = safeImage(product && product.image);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Get a restock alert</title>
<style>
  :root{--accent:${color};--text:#1f2a24;--muted:#646c66;--line:#dedad2;--bg:#ffffff;--soft:#f6f4ef;--ok:#1d6b3a;--bad:#b42318}
  @media (prefers-color-scheme:dark){:root{--text:#ecefe9;--muted:#a3aba4;--line:#353b37;--bg:#181b19;--soft:#212522;--ok:#5cc184;--bad:#f97066}}
  *{box-sizing:border-box} html,body{margin:0;background:transparent}
  body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--text)}
  .card{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:20px;max-width:440px}
  .product{display:flex;gap:12px;align-items:center;margin-bottom:16px}
  .product img{width:52px;height:52px;border-radius:8px;object-fit:cover;flex:none;background:var(--soft)}
  .pill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);background:var(--soft);border-radius:999px;padding:3px 8px;margin-bottom:3px}
  .pill.in{color:var(--ok);background:color-mix(in srgb,var(--ok) 14%,transparent)}
  .pname{font-weight:600;line-height:1.3}
  h2{font-size:18px;line-height:1.3;margin:0 0 4px} p{margin:0;color:var(--muted);font-size:14px}
  form{margin-top:14px;display:grid;gap:10px}
  label{font-size:13px;font-weight:600}
  input{width:100%;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:11px 12px;outline:none}
  input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
  button{font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:9px;padding:12px 16px;cursor:pointer}
  button[disabled]{opacity:.6;cursor:default}
  .msg{font-size:13px;min-height:1px} .msg.bad{color:var(--bad)}
  .fine{font-size:12px;color:var(--muted);margin-top:2px}
  .done{display:none;text-align:left} .done.show{display:block}
  .tick{width:36px;height:36px;border-radius:50%;background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok);display:grid;place-items:center;margin-bottom:10px;font-size:18px;font-weight:700}
  .hide{display:none}
</style></head>
<body>
<div class="card">
  ${name ? `<div class="product">${image ? `<img src="${esc(image)}" alt="" onerror="this.remove()">` : ''}<div><span class="pill${inStock ? ' in' : ''}">${inStock ? 'In stock' : 'Sold out'}</span><div class="pname">${esc(name)}</div></div></div>` : ''}
  <div id="ask"${inStock ? ' class="hide"' : ''}>
    <h2>Get an email when it's back</h2>
    <p>We'll send you one email the moment it's restocked. Nothing else.</p>
    <form id="f" novalidate>
      ${sku ? `<input type="hidden" name="sku" value="${esc(sku)}">` : `<div><label for="sku">Product code (SKU)</label><input id="sku" name="sku" required maxlength="64" autocomplete="off" placeholder="e.g. TEE-ORG-WHT-M"></div>`}
      <div><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com"></div>
      <button id="b" type="submit">Notify me</button>
      <div id="m" class="msg" role="status" aria-live="polite"></div>
    </form>
  </div>
  <div id="done" class="done${inStock ? ' show' : ''}" role="status" aria-live="polite">
    <div class="tick" aria-hidden="true">✓</div>
    <h2 id="dt">${inStock ? 'Good news: it is in stock now' : ''}</h2>
    <p id="dd">${inStock ? 'No need to wait. You can order it right away.' : ''}</p>
  </div>
</div>
<script>
(function () {
  var f = document.getElementById('f'), b = document.getElementById('b'), m = document.getElementById('m');
  var src = ''; try { src = document.referrer || ''; } catch (e) {}
  function show(title, text) {
    document.getElementById('ask').className = 'hide';
    document.getElementById('dt').textContent = title;
    document.getElementById('dd').textContent = text;
    document.getElementById('done').className = 'done show';
  }
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = f.email.value.trim(), sku = f.sku.value.trim();
    m.className = 'msg'; m.textContent = '';
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) { m.className = 'msg bad'; m.textContent = 'Please enter a valid email address.'; f.email.focus(); return; }
    if (!sku) { m.className = 'msg bad'; m.textContent = 'Please enter the product code.'; return; }
    b.disabled = true; b.textContent = 'Saving…';
    fetch('api/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email, sku: sku, source_url: src }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) throw new Error(x.j && x.j.error || 'Something went wrong.');
        if (x.j.status === 'in_stock') return show('Good news: it is in stock now', 'No need to wait. You can order it right away.');
        if (x.j.already_requested) return show("You're already on the list", 'We will email ' + email + ' once, when it is back.');
        show("You're on the list", 'We will email ' + email + ' once, when it is back in stock.');
      })
      .catch(function (err) { m.className = 'msg bad'; m.textContent = err.message || 'Could not save that. Please try again.'; b.disabled = false; b.textContent = 'Notify me'; });
  });
})();
</script>
</body></html>`;
}

// ---------------------------------------------------------------- admin

const fmtTime = (iso) => (iso ? `<time datetime="${esc(iso)}">${esc(iso.slice(0, 16).replace('T', ' '))}</time>` : '<span class="dim">—</span>');

function renderAdmin({ rows, counts, events, filter, q, catalog }) {
  const names = new Map(catalog.map((p) => [String(p.sku).toUpperCase(), p.name]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const tab = (key, label, n) => `<a class="tab${filter === key ? ' on' : ''}" href="?${key ? 'status=' + key : ''}${q ? `${key ? '&' : ''}q=${encodeURIComponent(q)}` : ''}">${label}<span>${n}</span></a>`;
  const statusLabel = { waiting: 'Waiting', sending: 'Sending', notified: 'Notified', failed: 'Failed' };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Restock alerts · Admin</title>
<style>
  :root{--bg:#f4f3ef;--card:#fff;--text:#1d2420;--muted:#66706a;--line:#e3e0d8;--accent:#1f2a24;
    --wait:#8a5a00;--wait-bg:#fbf1db;--ok:#1d6b3a;--ok-bg:#e3efe6;--bad:#b42318;--bad-bg:#fde8e6;--send:#2453b8;--send-bg:#e5ecfb}
  @media (prefers-color-scheme:dark){:root{--bg:#121513;--card:#1a1e1b;--text:#e7ebe7;--muted:#9aa49d;--line:#2c322e;--accent:#e7ebe7;
    --wait:#f2c46d;--wait-bg:#3a2f17;--ok:#6fd096;--ok-bg:#183223;--bad:#ff8f84;--bad-bg:#3b1d1a;--send:#8fb0ff;--send-bg:#1c2640}}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  main{max-width:1120px;margin:0 auto;padding:28px 16px 64px}
  header{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between;margin-bottom:20px}
  h1{font-size:22px;margin:0} .sub{color:var(--muted);margin:2px 0 0} h2{font-size:15px;margin:30px 0 10px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .stat b{display:block;font-size:24px;line-height:1.2;font-variant-numeric:tabular-nums} .stat span{color:var(--muted);font-size:13px}
  .bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:10px}
  .tabs{display:flex;flex-wrap:wrap;gap:6px}
  .tab{display:inline-flex;gap:6px;align-items:center;padding:6px 11px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--text);text-decoration:none;font-weight:600;font-size:13px}
  .tab span{color:var(--muted);font-weight:500} .tab.on{background:var(--accent);border-color:var(--accent);color:var(--bg)} .tab.on span{color:inherit;opacity:.75}
  form.search input{font:inherit;color:var(--text);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:7px 10px;width:240px;max-width:100%}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow-x:auto}
  table{width:100%;border-collapse:collapse;min-width:760px} th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em} tr:last-child td{border-bottom:0}
  td.num{font-variant-numeric:tabular-nums}
  .badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:600}
  .waiting{color:var(--wait);background:var(--wait-bg)} .notified{color:var(--ok);background:var(--ok-bg)} .failed{color:var(--bad);background:var(--bad-bg)} .sending{color:var(--send);background:var(--send-bg)}
  .dim{color:var(--muted)} .sku{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--muted)} .err{color:var(--bad);font-size:12px;margin-top:3px;max-width:340px}
  .empty{padding:28px;text-align:center;color:var(--muted)}
</style></head>
<body><main>
<header><div><h1>Restock alerts</h1><p class="sub">Customers waiting for sold-out products, and when each was emailed. Refreshes every 30 seconds.</p></div></header>
<section class="stats">
  <div class="stat"><b>${counts.waiting + counts.sending}</b><span>Waiting for restock</span></div>
  <div class="stat"><b>${counts.notified}</b><span>Emailed</span></div>
  <div class="stat"><b>${counts.failed}</b><span>Failed permanently</span></div>
  <div class="stat"><b>${total}</b><span>All requests</span></div>
</section>
<div class="bar">
  <nav class="tabs">${tab('', 'All', total)}${tab('waiting', 'Waiting', counts.waiting)}${tab('notified', 'Notified', counts.notified)}${tab('failed', 'Failed', counts.failed)}</nav>
  <form class="search" method="get">${filter ? `<input type="hidden" name="status" value="${esc(filter)}">` : ''}<input name="q" value="${esc(q)}" placeholder="Search email or SKU" aria-label="Search email or SKU"></form>
</div>
<div class="card"><table>
  <thead><tr><th>Customer</th><th>Product</th><th>Status</th><th>Requested (UTC)</th><th>Notified (UTC)</th><th>Attempts</th></tr></thead>
  <tbody>${rows.map((r) => `<tr>
    <td>${esc(r.email)}</td>
    <td>${names.get(r.sku) ? `${esc(names.get(r.sku))}<div class="sku">${esc(r.sku)}</div>` : `<span class="sku">${esc(r.sku)}</span>`}</td>
    <td><span class="badge ${esc(r.status)}">${statusLabel[r.status] || esc(r.status)}</span>${r.last_error && r.status !== 'notified' ? `<div class="err">${esc(r.last_error)}${r.next_attempt_at && r.status === 'waiting' ? ` · retry ${esc(r.next_attempt_at.slice(11, 16))} UTC` : ''}</div>` : ''}</td>
    <td class="num">${fmtTime(r.created_at)}</td>
    <td class="num">${fmtTime(r.notified_at)}</td>
    <td class="num">${r.attempts}</td></tr>`).join('') || `<tr><td colspan="6" class="empty">No requests${filter || q ? ' match this filter' : ' yet'}.</td></tr>`}</tbody>
</table></div>
<h2>Recent stock webhooks</h2>
<div class="card"><table>
  <thead><tr><th>Received (UTC)</th><th>Event</th><th>SKU</th><th>Qty claimed</th><th>Deliveries</th><th>Outcome</th></tr></thead>
  <tbody>${events.map((e) => `<tr><td class="num">${fmtTime(e.received_at)}</td><td class="sku">${esc(e.event_id)}</td><td class="sku">${esc(e.sku)}</td><td class="num">${e.quantity ?? '—'}</td>
    <td class="num">${e.deliveries}${e.deliveries > 1 ? ' <span class="dim">(duplicates ignored)</span>' : ''}</td><td>${esc(e.outcome || 'processing…')}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No webhooks yet.</td></tr>'}</tbody>
</table></div>
</main></body></html>`;
}

module.exports = { renderEmail, renderEmbed, renderAdmin, esc };
