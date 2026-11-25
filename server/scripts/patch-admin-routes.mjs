/**
 * Replace the admin route block in server/index.mjs.
 *
 * The back office is now handed to an outside reviewer, so the routes change in
 * four ways: reads are open to both roles, writes are owner-only, every write is
 * recorded in the audit trail, and the order page gained a printable receipt and
 * an email history. Nothing here trusts the browser to hide a button — each
 * refusal is decided on the server.
 *
 * Run once:  node server/scripts/patch-admin-routes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, '..', 'index.mjs');
const text = fs.readFileSync(FILE, 'utf8');

const start = text.indexOf("app.get('/admin', requireAdmin, (req, res) => {");
const marker = '/*  Development visual probe';
const markerIndex = text.indexOf(marker);
if (start < 0 || markerIndex < 0) {
  console.error('could not locate the admin block');
  process.exit(1);
}
// Back up to the opening of the comment banner that precedes the probe section.
const end = text.lastIndexOf('/* ---', markerIndex);

const block = `app.get('/admin', requireAdmin, (req, res) => {
  const { orders: list } = orders.listOrders({ limit: 12 });
  res.render('admin-dashboard', {
    page: 'admin',
    layout: 'admin-layout',
    view: 'admin-dashboard',
    title: 'Dashboard',
    stats: orders.orderStats(),
    recent: list,
    lowStock: catalog.lowStock(6),
    activity: audit.recent(12),
    auditSummary: audit.summary(),
    mailSummary: mail.mailSummary(),
    mailEnabled: mail.mailEnabled(),
  });
});

/* -------------------------------------------------------------------------- */
/*  Orders                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The order list, with the filters an accountant or a reviewer actually uses.
 *
 * from/to are plain dates and are applied to the order's creation date, not its
 * last update: "orders placed in February" is a question about when the customer
 * bought, and a status change must not move an order into another month's figures.
 */
function orderFilters(query) {
  return {
    status: String(query.status || ''),
    q: String(query.q || ''),
    from: String(query.from || ''),
    to: String(query.to || ''),
  };
}

app.get('/admin/orders', requireAdmin, (req, res) => {
  const filters = orderFilters(req.query);
  const { orders: list, total } = orders.listOrders({ limit: 200, ...filters });
  res.render('admin-orders', {
    page: 'admin',
    layout: 'admin-layout',
    view: 'admin-orders',
    title: 'Orders',
    orders: list,
    total,
    filters,
    statuses: orders.ORDER_STATUSES,
    mailEnabled: mail.mailEnabled(),
  });
});

/**
 * CSV export of exactly what the list is showing.
 *
 * Semicolon-free, quoted CSV with a UTF-8 BOM: Excel on a Windows machine opens a
 * BOM-less UTF-8 file as the system codepage, which turns a customer name with an
 * accent into mojibake in the accountant's spreadsheet — the one place this data
 * has to be correct.
 */
app.get('/admin/orders.csv', requireAdmin, (req, res) => {
  const filters = orderFilters(req.query);
  const { orders: list } = orders.listOrders({ limit: 500, ...filters });

  const columns = [
    ['order_number', (o) => o.order_number],
    ['placed_at', (o) => o.created_at],
    ['paid_at', (o) => o.paid_at || ''],
    ['status', (o) => o.status],
    ['payment_status', (o) => o.payment_status],
    ['customer_name', (o) => o.customer_name],
    ['customer_email', (o) => o.customer_email],
    ['customer_phone', (o) => o.customer_phone || ''],
    ['ship_to_name', (o) => o.shipping_name],
    ['ship_to_line1', (o) => o.shipping_line1],
    ['ship_to_line2', (o) => o.shipping_line2 || ''],
    ['ship_to_city', (o) => o.shipping_city],
    ['ship_to_province', (o) => o.shipping_province],
    ['ship_to_postal_code', (o) => o.shipping_postal_code],
    ['ship_to_country', (o) => o.shipping_country],
    ['shipping_method', (o) => o.shipping_method],
    ['currency', (o) => o.currency],
    ['subtotal', (o) => (o.subtotal_cents / 100).toFixed(2)],
    ['shipping', (o) => (o.shipping_cents / 100).toFixed(2)],
    ['tax', (o) => (o.tax_cents / 100).toFixed(2)],
    ['total', (o) => (o.total_cents / 100).toFixed(2)],
    ['refunded', (o) => (o.refunded_cents / 100).toFixed(2)],
    ['card', (o) => [o.ott_cc_type, o.ott_card_last4 ? '****' + o.ott_card_last4 : ''].filter(Boolean).join(' ')],
    ['gateway_reference', (o) => o.ott_reference || ''],
    ['gateway_payment_id', (o) => o.ott_payment_id || ''],
    ['item_count', (o) => (o.items || []).reduce((n, i) => n + i.quantity, 0)],
  ];

  const cell = (value) => {
    const s = String(value ?? '');
    return /[",\\r\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [
    columns.map(([name]) => name).join(','),
    ...list.map((o) => columns.map(([, get]) => cell(get(o))).join(',')),
  ];

  audit.record({
    actor: req.admin.email,
    role: req.admin.role,
    action: 'orders.export',
    target: 'orders.csv',
    detail: \`\${list.length} row(s) \${JSON.stringify(filters)}\`,
    ip: security.clientIp(req),
  });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', \`attachment; filename="orders-\${stamp}.csv"\`);
  res.send('\ufeff' + rows.join('\\r\\n') + '\\r\\n');
});

app.get('/admin/orders/:orderNumber', requireAdmin, (req, res, next) => {
  const order = orders.getOrderByNumber(req.params.orderNumber);
  if (!order) return next();
  res.render('admin-order', {
    page: 'admin',
    layout: 'admin-layout',
    view: 'admin-order',
    title: \`Order \${order.order_number}\`,
    order,
    req,
    statuses: orders.ORDER_STATUSES,
    webhooks: dbAll('SELECT * FROM webhook_events WHERE order_id = ? OR decrypted LIKE ? ORDER BY id DESC LIMIT 20', order.order_number, \`%\${order.ott_reference}%\`),
    orderActivity: audit.forOrder(order.order_number, 20),
    emails: mail.mailForOrder(order.order_number, 10),
    mailEnabled: mail.mailEnabled(),
  });
});

/**
 * A printable receipt.
 *
 * The acquirer's reviewer and any accountant both eventually want the same thing:
 * a document for one order, in the shape a receipt has. Rendering it here rather
 * than as a PDF keeps it dependency-free and printable from any browser, and it
 * carries the same identity block as the policy pages, which is what makes it
 * useful in a dispute.
 */
app.get('/admin/orders/:orderNumber/receipt', requireAdmin, (req, res, next) => {
  const order = orders.getOrderByNumber(req.params.orderNumber);
  if (!order) return next();
  audit.record({
    actor: req.admin.email,
    role: req.admin.role,
    action: audit.ACTIONS.ORDER_RECEIPT,
    target: order.order_number,
    ip: security.clientIp(req),
  });
  res.render('admin-receipt', {
    layout: false,
    title: \`Receipt \${order.order_number}\`,
    order,
    company: config.company,
    store: config.store,
    money: (cents) => \`\${order.currency} \${(Number(cents || 0) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\`,
    printedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    asset: assetUrl,
  });
});

app.post('/admin/orders/:orderNumber/status', requireWriter, (req, res) => {
  const order = orders.getOrderByNumber(req.params.orderNumber);
  if (!order) return res.status(404).send('Not found');
  const status = String(req.body.status || '');
  const tracking = String(req.body.tracking || '').trim();
  const carrier = String(req.body.carrier || '').trim();
  const previous = order.status;
  try {
    orders.updateOrderStatus(order.id, status, req.body.adminNote ?? null);
    if (status === 'cancelled' && !order.paid_at) orders.restockOrder(order.id);
  } catch (err) {
    return res.status(400).send(err.message);
  }

  audit.record({
    actor: req.admin.email,
    role: req.admin.role,
    action: audit.ACTIONS.ORDER_STATUS,
    target: order.order_number,
    detail: \`\${previous} → \${status}\${req.body.adminNote ? \` · \${String(req.body.adminNote).slice(0, 200)}\` : ''}\`,
    ip: security.clientIp(req),
  });

  /*
   * Dispatch notice, sent only on the transition into shipped and only when a
   * tracking number was entered. Re-saving an already-shipped order must not mail
   * the customer a second time.
   */
  if (status === 'shipped' && previous !== 'shipped' && tracking) {
    const fresh = orders.getOrderByNumber(order.order_number);
    mail
      .sendDispatchNotice(fresh, { trackingNumber: tracking, carrier })
      .then((result) => {
        audit.record({
          actor: req.admin.email,
          role: req.admin.role,
          action: audit.ACTIONS.MAIL_SEND,
          target: order.order_number,
          detail: \`dispatch notice \${result.ok ? 'sent' : result.skipped ? 'skipped' : \`failed: \${result.error}\`}\`,
          ip: security.clientIp(req),
        });
      })
      .catch(() => {});
  }

  res.redirect(\`/admin/orders/\${order.order_number}\`);
});

app.post('/admin/orders/:orderNumber/refund', requireWriter, async (req, res) => {
  const order = orders.getOrderByNumber(req.params.orderNumber);
  if (!order) return res.status(404).send('Not found');

  if (!order.ott_payment_id && !order.ott_reference) {
    return res.status(400).send('This order has no payment to refund.');
  }
  const requested = req.body.full === '1'
    ? order.total_cents - order.refunded_cents
    : Math.round((Number.parseFloat(req.body.amount) || 0) * 100);

  if (requested <= 0 || requested > order.total_cents - order.refunded_cents) {
    return res.status(400).send('Invalid refund amount.');
  }

  const result = await payments.refundPayment({
    oriPaymentId: order.ott_payment_id || order.ott_reference,
    refundAmountCents: requested,
  });

  audit.record({
    actor: req.admin.email,
    role: req.admin.role,
    action: audit.ACTIONS.ORDER_REFUND,
    target: order.order_number,
    detail: \`\${(requested / 100).toFixed(2)} \${order.currency} · \${result.ok ? 'accepted' : \`rejected: \${result.error?.message || 'error'}\`}\${req.body.reason ? \` · \${String(req.body.reason).slice(0, 120)}\` : ''}\`,
    ip: security.clientIp(req),
  });

  if (!result.ok) {
    orders.recordRefund({
      orderId: order.id,
      oriPaymentId: order.ott_payment_id,
      amountCents: requested,
      status: 'failure',
      reason: req.body.reason || '',
      responsePayload: result.error,
    });
    return res.redirect(\`/admin/orders/\${order.order_number}?refund=failed\`);
  }

  orders.recordRefund({
    orderId: order.id,
    refundId: result.data.refundId,
    oriPaymentId: order.ott_payment_id,
    amountCents: requested,
    status: result.data.refundStatus === 'failure' ? 'failure' : 'success',
    reason: req.body.reason || '',
    responsePayload: result.data.responsePayload,
  });

  if (result.data.refundStatus !== 'failure') {
    const fresh = orders.getOrderByNumber(order.order_number);
    const fully = fresh.refunded_cents >= fresh.total_cents;
    mail
      .sendRefundNotice(fresh, { amountCents: requested, full: fully })
      .then((sent) => {
        audit.record({
          actor: req.admin.email,
          role: req.admin.role,
          action: audit.ACTIONS.MAIL_SEND,
          target: order.order_number,
          detail: \`refund notice \${sent.ok ? 'sent' : sent.skipped ? 'skipped' : \`failed: \${sent.error}\`}\`,
          ip: security.clientIp(req),
        });
      })
      .catch(() => {});
  }

  res.redirect(\`/admin/orders/\${order.order_number}?refund=ok\`);
});

app.post('/admin/orders/:orderNumber/sync', requireWriter, async (req, res) => {
  const order = orders.getOrderByNumber(req.params.orderNumber);
  if (!order) return res.status(404).send('Not found');
  const result = await payments.fetchPaymentStatus({ paymentId: order.ott_payment_id, reference: order.ott_reference });
  if (result.ok) {
    const status = String(result.data.paymentStatus || '').toLowerCase();
    if (payments.PAID_STATUSES.has(status) || status === 'success') {
      orders.applyPaymentResult({
        orderId: order.id,
        reference: order.ott_reference,
        result: { paymentStatus: 'captured', paymentId: result.data.paymentId, responsePayload: result.data.responsePayload },
      });
      await sendReceiptOnce(orders.getOrderByNumber(order.order_number));
    }
  }
  audit.record({
    actor: req.admin.email,
    role: req.admin.role,
    action: audit.ACTIONS.ORDER_SYNC,
    target: order.order_number,
    detail: result.ok ? \`gateway says \${result.data.paymentStatus || 'unknown'}\` : \`failed: \${result.error?.message || 'error'}\`,
    ip: security.clientIp(req),
  });
  res.redirect(\`/admin/orders/\${order.order_number}?sync=\${result.ok ? 'ok' : 'failed'}\`);
});

/* -------------------------------------------------------------------------- */
/*  Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

app.get('/admin/products', requireAdmin, (req, res) => {
  const { products, total } = catalog.listProducts({ limit: 200, sort: 'name' });
  res.render('admin-products', {
    page: 'admin',
    layout: 'admin-layout',
    view: 'admin-products',
    title: 'Catalogue',
    products,
    total,
  });
});

app.post('/admin/products/:variantId/stock', requireWriter, (req, res) => {
  const stock = Math.max(0, Math.min(100000, Number.parseInt(req.body.stock, 10) || 0));
  const before = dbGet('SELECT v.stock, p.name, v.label FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', Number(req.params.variantId));
  dbRun('UPDATE variants SET stock = ? WHERE id = ?', stock, Number(req.params.variantId));
  catalog.invalidateChrome();
  audit.record({
    actor: req.admin.email,
    role: req.admin.role,
    action: audit.ACTIONS.STOCK_UPDATE,
    target: String(req.params.variantId),
    detail: before ? \`\${before.name} · \${before.label}: \${before.stock} → \${stock}\` : \`stock → \${stock}\`,
    ip: security.clientIp(req),
  });
  res.redirect(req.get('referer') || '/admin/products');
});

/* -------------------------------------------------------------------------- */
/*  Payments, email and settings                                               */
/* -------------------------------------------------------------------------- */

app.get('/admin/webhooks', requireAdmin, (req, res) => {
  res.render('admin-webhooks', {
    page: 'admin',
    layout: 'admin-layout',
    view: 'admin-webhooks',
    title: 'Payment callbacks',
    events: dbAll('SELECT * FROM webhook_events ORDER BY id DESC LIMIT 100'),
  });
});

app.get('/admin/emails', requireAdmin, (req, res) => {
  res.render('admin-emails', {
    page: 'admin',
    layout: 'admin-layout',
    view: 'admin-emails',
    title: 'Email',
    emails: mail.recentMail(100),
    mailEnabled: mail.mailEnabled(),
    mailReason: config.mail.reason,
    mailFrom: config.mail.from,
    summary: mail.mailSummary(),
  });
});

/**
 * Send a test message to the signed-in staff member.
 *
 * The point is to be able to prove, in front of an acquirer, that the shop can
 * deliver a receipt — without placing a fake order.
 */
app.post('/admin/emails/test', requireWriter, async (req, res) => {
  const to = String(req.body.to || req.admin.email).trim();
  const rendered = mail.renderOrderReceipt(orders.getOrderByNumber(String(req.body.orderNumber || '')) || {
    order_number: 'CY-TEST-0000',
    currency: config.store.currency,
    customer_name: 'Test Recipient',
    customer_email: to,
    subtotal_cents: 12000,
    shipping_cents: 0,
    tax_cents: 1560,
    total_cents: 13560,
    shipping_method: 'Standard',
    shipping_name: 'Test Recipient',
    shipping_line1: '1 Test Street',
    shipping_city: 'Markham',
    shipping_province: 'ON',
    shipping_postal_code: 'L3R 3K2',
    shipping_country: 'Canada',
    items: [{ product_name: 'Test item', variant_label: 'sample', sku: 'CY-TEST-000', quantity: 1, line_total_cents: 12000 }],
  });
  const result = await mail.send({ kind: 'test', to, orderNumber: '', ...rendered });
  audit.record({
    actor: req.admin.email,
    role: req.admin.role,
    action: audit.ACTIONS.MAIL_TEST,
    target: to,
    detail: result.ok ? 'sent' : \`\${result.skipped ? 'skipped' : 'failed'}: \${result.error}\`,
    ip: security.clientIp(req),
  });
  res.redirect(\`/admin/emails?test=\${result.ok ? 'ok' : result.skipped ? 'skipped' : 'failed'}\`);
});

app.get('/admin/settings', requireAdmin, (req, res) => {
  const review = validateConfig();
  res.render('admin-settings', {
    page: 'admin',
    layout: 'admin-layout',
    view: 'admin-settings',
    title: 'Settings',
    problems: review.problems,
    warnings: review.warnings,
    mailEnabled: mail.mailEnabled(),
    mailReason: config.mail.reason,
  });
});

app.get('/admin/activity', requireAdmin, (req, res) => {
  res.render('admin-activity', {
    page: 'admin',
    layout: 'admin-layout',
    view: 'admin-activity',
    title: 'Activity log',
    actions: audit.recent(200),
    summary: audit.summary(),
  });
});

`;

fs.writeFileSync(FILE, text.slice(0, start) + block + text.slice(end));
console.log('  admin routes replaced');
