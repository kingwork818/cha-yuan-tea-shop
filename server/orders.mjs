/**
 * Order domain logic: pricing, order creation, payment state updates and refunds.
 */
import crypto from 'node:crypto';
import config from './config.mjs';
import { all, get, run, transaction } from './db.mjs';
import * as payments from './payments.mjs';
import { variantSku } from './sku.mjs';
import { photoUrl } from './asset-version.mjs';

/* ------------------------------------------------------------------ pricing */

/**
 * Server-authoritative cart pricing. The client never sends prices — it sends
 * variant ids and quantities, and we look up every price from the database.
 *
 * @param {Array<{variantId:number, quantity:number}>} lines
 * @param {{shippingMethod?:string}} options
 */
export function priceCart(lines, { shippingMethod = 'standard' } = {}) {
  const items = [];
  const problems = [];

  for (const line of Array.isArray(lines) ? lines : []) {
    const variantId = Number(line?.variantId);
    const quantity = Math.max(0, Math.min(99, Number(line?.quantity) || 0));
    if (!variantId || !quantity) continue;

    const row = get(
      `SELECT v.id AS variant_id, v.label AS variant_label, v.price_cents, v.stock, v.weight_grams,
              p.id AS product_id, p.slug, p.name, p.sku, p.hero_image, p.tea_family
         FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.id = ? AND p.is_active = 1`,
      variantId,
    );
    if (!row) {
      problems.push({ variantId, message: 'That product is no longer available.' });
      continue;
    }
    if (row.stock <= 0) {
      problems.push({ variantId, message: `${row.name} (${row.variant_label}) is out of stock.` });
      continue;
    }
    if (quantity > row.stock) {
      problems.push({
        variantId,
        message: `Only ${row.stock} of ${row.name} (${row.variant_label}) left — quantity reduced.`,
      });
    }
    const qty = Math.min(quantity, row.stock);

    items.push({
      variantId: row.variant_id,
      productId: row.product_id,
      slug: row.slug,
      name: row.name,
      variantLabel: row.variant_label,
      sku: variantSku(row.sku, row.variant_label),
      unitPriceCents: row.price_cents,
      quantity: qty,
      lineTotalCents: row.price_cents * qty,
      image: photoUrl(row.hero_image),
      weightGrams: (row.weight_grams || 0) * qty,
    });
  }

  const subtotalCents = items.reduce((sum, i) => sum + i.lineTotalCents, 0);
  const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);

  let shippingCents = 0;
  if (subtotalCents > 0 && subtotalCents < config.store.freeShippingThreshold) {
    shippingCents = shippingMethod === 'express' ? config.store.flatShippingFee * 2 : config.store.flatShippingFee;
  } else if (subtotalCents > 0 && shippingMethod === 'express') {
    shippingCents = Math.round(config.store.flatShippingFee * 1.5);
  }

  const discountCents = 0;
  const taxableCents = subtotalCents + shippingCents - discountCents;
  const taxCents = Math.round(taxableCents * config.store.taxRate);
  const totalCents = taxableCents + taxCents;

  return {
    items,
    problems,
    itemCount,
    subtotalCents,
    shippingCents,
    discountCents,
    taxCents,
    totalCents,
    currency: config.store.currency,
    freeShippingThreshold: config.store.freeShippingThreshold,
    freeShippingRemaining: Math.max(0, config.store.freeShippingThreshold - subtotalCents),
  };
}

/* ------------------------------------------------------------- order numbers */

function nextOrderNumber() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const row = get(`SELECT COUNT(*) AS n FROM orders WHERE order_number LIKE ?`, `CY-${stamp}-%`);
  const seq = (row?.n ?? 0) + 1;
  return `CY-${stamp}-${String(seq).padStart(4, '0')}`;
}

/** Reference sent to OTT Pay. Unique, alphanumeric, traceable back to the order. */
export function newReference(orderNumber) {
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${orderNumber.replace(/[^0-9A-Za-z]/g, '')}${suffix}`.slice(0, 32);
}

/** KOUNT session id: MID + timestamp + 4 random digits, <= 32 alphanumeric chars. */
export function newKountSessionId() {
  const mid = (config.payment.merchantId || 'MOCK').replace(/[^0-9A-Za-z]/g, '');
  const rand = String(Math.floor(Math.random() * 9000) + 1000);
  return `${mid}-${Date.now()}-${rand}`.slice(0, 32);
}

/* -------------------------------------------------------------- create order */

/**
 * Create an order from a priced cart. Decrements stock atomically.
 * @returns {{orderId:number, orderNumber:string, totalCents:number}}
 */
export function createOrder({ priced, customer, shipping, shippingMethod = 'standard', note = '' }) {
  if (!priced.items.length) throw new Error('Cannot create an order with an empty cart');

  return transaction(() => {
    const orderNumber = nextOrderNumber();

    run(
      `INSERT INTO orders (
         order_number, status, payment_status, payment_method, currency,
         subtotal_cents, shipping_cents, tax_cents, discount_cents, total_cents,
         customer_email, customer_name, customer_phone,
         shipping_name, shipping_line1, shipping_line2, shipping_city, shipping_province,
         shipping_postal_code, shipping_country, shipping_method, customer_note
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      orderNumber,
      'awaiting_payment',
      'unpaid',
      'ottpay_local_card',
      config.store.currency,
      priced.subtotalCents,
      priced.shippingCents,
      priced.taxCents,
      priced.discountCents,
      priced.totalCents,
      customer.email || '',
      customer.name || '',
      customer.phone || '',
      shipping.name || customer.name || '',
      shipping.line1 || '',
      shipping.line2 || '',
      shipping.city || '',
      shipping.province || '',
      shipping.postalCode || '',
      (shipping.country || 'CA').toUpperCase(),
      shippingMethod,
      note || '',
    );

    const order = get('SELECT id FROM orders WHERE order_number = ?', orderNumber);

    for (const item of priced.items) {
      run(
        `INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_label, sku,
                                  unit_price_cents, quantity, line_total_cents, image)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        order.id,
        item.productId,
        item.variantId,
        item.name,
        item.variantLabel,
        item.sku,
        item.unitPriceCents,
        item.quantity,
        item.lineTotalCents,
        item.image,
      );
      // Reserve stock.
      run('UPDATE variants SET stock = stock - ? WHERE id = ?', item.quantity, item.variantId);
    }

    return { orderId: order.id, orderNumber, totalCents: priced.totalCents };
  });
}

/* -------------------------------------------------------------- read orders */

export function getOrderById(id) {
  const order = get('SELECT * FROM orders WHERE id = ?', Number(id));
  if (!order) return null;
  // The department is joined in so downstream copy can tell a tea order from a
  // jade or jewellery one: the confirmation page must not tell someone their
  // bangle is "weighed to the gram". A LEFT JOIN keeps historical orders
  // readable if the product has since been removed from the catalogue.
  order.items = all(
    `SELECT oi.*, COALESCE(c.kind, '') AS category_kind
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE oi.order_id = ? ORDER BY oi.id`,
    order.id,
  );
  order.attempts = all('SELECT * FROM payment_attempts WHERE order_id = ? ORDER BY id DESC', order.id);
  order.refunds = all('SELECT * FROM refunds WHERE order_id = ? ORDER BY id DESC', order.id);
  return order;
}

export function getOrderByNumber(orderNumber) {
  const row = get('SELECT id FROM orders WHERE order_number = ?', String(orderNumber));
  return row ? getOrderById(row.id) : null;
}

export function getOrderByReference(reference) {
  const row = get('SELECT id FROM orders WHERE ott_reference = ?', String(reference));
  if (row) return getOrderById(row.id);
  const attempt = get('SELECT order_id FROM payment_attempts WHERE reference = ?', String(reference));
  return attempt ? getOrderById(attempt.order_id) : null;
}

export function listOrders({ limit = 100, offset = 0, status = '', search = '', from = '', to = '', archived = 'exclude' } = {}) {
  const where = [];
  const params = [];
  /*
   * Archived orders are out of the way by default — that is the point of
   * archiving — but they are never invisible: `archived=only` lists exactly them,
   * and `archived=include` shows both. A filter that quietly hides rows is the
   * difference between tidying a shop and misleading a reviewer.
   */
  if (archived === 'only') where.push('archived_at IS NOT NULL');
  else if (archived !== 'include') where.push('archived_at IS NULL');

  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (search) {
    where.push('(order_number LIKE ? OR customer_email LIKE ? OR customer_name LIKE ? OR ott_payment_id LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  /*
   * Dates filter on when the order was placed, not when it was last touched. A
   * reconciliation asks "what did we sell in February", and applying a status
   * change in March must not move a February order into March's figures.
   *
   * Both bounds are date() comparisons rather than a bare string compare: a bare
   * `<= '2026-02-28'` is midnight, and silently drops everything placed that day.
   */
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    where.push('date(created_at) >= date(?)');
    params.push(from);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    where.push('date(created_at) <= date(?)');
    params.push(to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(
    `SELECT * FROM orders ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...params,
    Math.min(5000, Number(limit) || 100),
    Number(offset) || 0,
  );
  const total = get(`SELECT COUNT(*) AS n FROM orders ${clause}`, ...params);
  return { orders: rows, total: total?.n ?? 0 };
}

export function orderStats() {
  const paidStates = `('paid','processing','shipped','delivered')`;
  // Archived orders are excluded from every figure: a demonstration order must
  // not inflate revenue on the dashboard an acquirer is looking at.
  const live = 'archived_at IS NULL';
  return {
    total: get(`SELECT COUNT(*) AS n FROM orders WHERE ${live}`)?.n ?? 0,
    awaiting: get(`SELECT COUNT(*) AS n FROM orders WHERE ${live} AND status IN ('awaiting_payment','pending')`)?.n ?? 0,
    paid: get(`SELECT COUNT(*) AS n FROM orders WHERE ${live} AND status IN ${paidStates}`)?.n ?? 0,
    refunded: get(`SELECT COUNT(*) AS n FROM orders WHERE ${live} AND status = 'refunded'`)?.n ?? 0,
    archived: get('SELECT COUNT(*) AS n FROM orders WHERE archived_at IS NOT NULL')?.n ?? 0,
    revenue: get(`SELECT COALESCE(SUM(total_cents),0) AS v FROM orders WHERE ${live} AND status IN ${paidStates}`)?.v ?? 0,
    units: get(`SELECT COALESCE(SUM(oi.quantity),0) AS v FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.archived_at IS NULL AND o.status IN ${paidStates}`)?.v ?? 0,
    pendingWebhooks: get('SELECT COUNT(*) AS n FROM webhook_events WHERE processed = 0')?.n ?? 0,
  };
}

/* ------------------------------------------------------- archive and purge */

/**
 * Orders that look like they were placed by a test rather than a customer.
 *
 * A suggestion list, never an automatic decision: the back office shows these
 * with the reason each one matched, and a person chooses. Guessing wrong in the
 * other direction — archiving a real customer's order — would be far worse than
 * leaving a test order in the list, so nothing here deletes or hides anything on
 * its own.
 *
 * The signature is deliberately narrow: a reserved domain in the address, or a
 * name that only the test fixtures use. A real order matching one of these by
 * accident is possible, which is exactly why the reason is shown next to it.
 */
const TEST_SIGNATURES = [
  { why: 'reserved .test address', sql: "customer_email LIKE '%.test'" },
  { why: 'example.com address', sql: "customer_email LIKE '%@example.com'" },
  { why: 'smoke-test name', sql: "customer_name LIKE 'Smoke Tester%'" },
  { why: 'demo fixture name', sql: "customer_name LIKE 'Review %'" },
  { why: 'marked as a test in the note', sql: "(customer_note LIKE '%smoke test%' OR customer_note LIKE '%access check%')" },
];

export function testOrderCandidates(limit = 500) {
  const condition = TEST_SIGNATURES.map((s) => s.sql).join(' OR ');
  const rows = all(
    `SELECT * FROM orders WHERE archived_at IS NULL AND (${condition}) ORDER BY id DESC LIMIT ?`,
    Math.min(2000, Number(limit) || 500),
  );
  return rows.map((row) => ({
    ...row,
    reasons: TEST_SIGNATURES
      .filter((s) => {
        const probe = get(`SELECT 1 AS hit FROM orders WHERE id = ? AND (${s.sql})`, row.id);
        return Boolean(probe);
      })
      .map((s) => s.why),
  }));
}

/**
 * Archive orders.
 *
 * Refuses anything carrying a gateway payment id while the shop is taking real
 * payments: that is a financial record with money behind it, and hiding it from
 * the reconciliation is not a tidy-up. Those have to be refunded or cancelled
 * through the normal flow instead.
 */
export function archiveOrders(ids, { allowRealPayments = false } = {}) {
  return transaction(() => {
    const archived = [];
    const refused = [];
    for (const rawId of ids) {
      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0) continue;
      const order = get('SELECT * FROM orders WHERE id = ?', id);
      if (!order) continue;
      if (order.archived_at) {
        refused.push({ order_number: order.order_number, why: 'already archived' });
        continue;
      }
      if (!allowRealPayments && order.ott_payment_id) {
        refused.push({
          order_number: order.order_number,
          why: 'has a gateway payment id — refund or cancel it instead',
        });
        continue;
      }
      run("UPDATE orders SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", id);
      archived.push(order.order_number);
    }
    return { archived, refused };
  });
}

export function unarchiveOrders(ids) {
  return transaction(() => {
    const restored = [];
    for (const rawId of ids) {
      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0) continue;
      const order = get('SELECT * FROM orders WHERE id = ? AND archived_at IS NOT NULL', id);
      if (!order) continue;
      run('UPDATE orders SET archived_at = NULL, updated_at = datetime(\'now\') WHERE id = ?', id);
      restored.push(order.order_number);
    }
    return restored;
  });
}

/**
 * Permanently delete archived orders.
 *
 * Only archived rows, so nothing can be destroyed without first being hidden and
 * looked at. Children are removed explicitly rather than relying on ON DELETE
 * CASCADE: refunds are a financial record, and the moment they disappear silently
 * is the moment nobody can answer a chargeback question later.
 */
export function purgeArchivedOrders(ids = null) {
  return transaction(() => {
    const targets = ids && ids.length
      ? all(
        `SELECT id, order_number FROM orders WHERE archived_at IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`,
        ...ids.map(Number),
      )
      : all('SELECT id, order_number FROM orders WHERE archived_at IS NOT NULL');
    for (const target of targets) {
      run('DELETE FROM order_items WHERE order_id = ?', target.id);
      run('DELETE FROM payment_attempts WHERE order_id = ?', target.id);
      run('DELETE FROM refunds WHERE order_id = ?', target.id);
      run('DELETE FROM orders WHERE id = ?', target.id);
    }
    return targets.map((t) => t.order_number);
  });
}

/* ------------------------------------------------------------ payment state */

/**
 * Record the outcome of a payment attempt against its order.
 * Idempotent: replays of the same paymentId do not move an order backwards.
 */
export function applyPaymentResult({ orderId, reference, result }) {
  return transaction(() => {
    const order = get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!order) return { changed: false, reason: 'order-not-found' };

    const status = String(result.paymentStatus || '').toLowerCase();
    const paid = payments.PAID_STATUSES.has(status);
    const challenge = status === 'threeds_auth_challenge';
    const failed = ['orderclosed', 'refused', 'failed', 'cancelled', 'error', 'failure'].includes(status);

    run(
      `UPDATE payment_attempts
          SET status = ?, ott_payment_id = ?, ott_payment_status = ?, cc_type = ?, card_last4 = ?,
              response_payload = ?, updated_at = datetime('now')
        WHERE reference = ?`,
      paid ? 'paid' : challenge ? 'challenge' : failed ? 'failed' : 'pending',
      result.paymentId || '',
      result.paymentStatus || '',
      result.ccType || '',
      result.cardLast4 || '',
      JSON.stringify(result.responsePayload ?? {}).slice(0, 20000),
      reference,
    );

    // Never downgrade an order that is already paid or shipped.
    if (['paid', 'processing', 'shipped', 'delivered', 'refunded'].includes(order.status) && !paid) {
      return { changed: false, reason: 'already-paid' };
    }

    const paymentStatus = paid
      ? 'success'
      : challenge
        ? 'challenge'
        : failed
          ? 'failed'
          : 'init';

    run(
      `UPDATE orders
          SET payment_status = ?,
              status = ?,
              ott_reference = ?,
              ott_payment_id = COALESCE(NULLIF(?, ''), ott_payment_id),
              ott_cc_type = COALESCE(NULLIF(?, ''), ott_cc_type),
              ott_card_last4 = COALESCE(NULLIF(?, ''), ott_card_last4),
              ott_payment_status = ?,
              paid_at = CASE WHEN ? = 1 THEN COALESCE(paid_at, datetime('now')) ELSE paid_at END,
              updated_at = datetime('now')
        WHERE id = ?`,
      paymentStatus,
      paid ? 'paid' : challenge ? 'awaiting_payment' : failed ? 'pending' : order.status,
      reference,
      result.paymentId || '',
      result.ccType || '',
      result.cardLast4 || '',
      result.paymentStatus || '',
      paid ? 1 : 0,
      orderId,
    );

    return { changed: true, paid, paymentStatus };
  });
}

/** Record a newly created payment attempt and stamp the order with its reference. */
export function recordAttempt({ orderId, reference, amountCents, kountSessionId, requestPayload }) {
  return transaction(() => {
    run(
      `INSERT INTO payment_attempts (order_id, reference, amount_cents, status, kount_session_id, request_payload)
       VALUES (?,?,?,?,?,?)`,
      orderId,
      reference,
      amountCents,
      'created',
      kountSessionId || '',
      JSON.stringify(requestPayload ?? {}).slice(0, 20000),
    );
    run('UPDATE orders SET ott_reference = ?, payment_status = ?, updated_at = datetime(\'now\') WHERE id = ?', reference, 'init', orderId);
  });
}

/* ----------------------------------------------------------------- refunds */

export function recordRefund({ orderId, refundId, oriPaymentId, amountCents, status, reason, responsePayload }) {
  return transaction(() => {
    run(
      `INSERT INTO refunds (order_id, refund_id, ori_payment_id, amount_cents, status, reason, response_payload)
       VALUES (?,?,?,?,?,?,?)`,
      orderId,
      refundId || '',
      oriPaymentId || '',
      amountCents,
      status || 'init',
      reason || '',
      JSON.stringify(responsePayload ?? {}).slice(0, 20000),
    );

    const total = get('SELECT COALESCE(SUM(amount_cents),0) AS v FROM refunds WHERE order_id = ? AND status IN (?,?)', orderId, 'success', 'processing');
    const order = get('SELECT total_cents, status FROM orders WHERE id = ?', orderId);
    const refunded = total?.v ?? 0;
    const fully = refunded >= (order?.total_cents ?? 0);

    run(
      `UPDATE orders SET refunded_cents = ?, status = ?, payment_status = ?, updated_at = datetime('now') WHERE id = ?`,
      refunded,
      fully ? 'refunded' : order.status,
      fully ? 'refunded' : refunded > 0 ? 'partial_refunded' : 'success',
      orderId,
    );
    return { refundedCents: refunded, fully };
  });
}

/* ------------------------------------------------------------ admin updates */

const ORDER_STATUSES = ['pending', 'awaiting_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];

export function updateOrderStatus(orderId, status, adminNote = null, { trackingNumber = '', trackingCarrier = '' } = {}) {
  if (!ORDER_STATUSES.includes(status)) throw new Error(`Unknown order status: ${status}`);
  /*
   * shipped_at is stamped once. Re-saving an already-shipped order (to correct a
   * note, say) must not move the dispatch date, because the dispatch date is what
   * the delivery estimate and any late-delivery complaint are measured from.
   */
  run(
    `UPDATE orders
        SET status = ?,
            admin_note = COALESCE(?, admin_note),
            tracking_number = CASE WHEN ? <> '' THEN ? ELSE tracking_number END,
            tracking_carrier = CASE WHEN ? <> '' THEN ? ELSE tracking_carrier END,
            shipped_at = CASE WHEN ? = 'shipped' THEN COALESCE(shipped_at, datetime('now')) ELSE shipped_at END,
            updated_at = datetime('now')
      WHERE id = ?`,
    status,
    adminNote,
    trackingNumber,
    trackingNumber,
    trackingCarrier,
    trackingCarrier,
    status,
    Number(orderId),
  );
  return getOrderById(orderId);
}

/** Return reserved stock to the shelf (used when an order is cancelled). */
export function restockOrder(orderId) {
  return transaction(() => {
    const items = all('SELECT variant_id, quantity FROM order_items WHERE order_id = ?', Number(orderId));
    for (const item of items) {
      if (item.variant_id) run('UPDATE variants SET stock = stock + ? WHERE id = ?', item.quantity, item.variant_id);
    }
    return items.length;
  });
}

export { ORDER_STATUSES };
