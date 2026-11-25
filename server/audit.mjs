/**
 * The back-office audit trail.
 *
 * One row per staff action. This is the difference between a shop that says "we
 * refund promptly" and a shop that can show a reviewer exactly which order was
 * refunded, by which login, at what time, for what reason.
 *
 * It is also what makes handing out a read-only account safe. The acquirer's
 * reviewer logs in with their own credentials, so anything that happens during
 * their session is attributable to them rather than to the owner — and if the
 * credentials are later revoked, the rows they wrote stay readable.
 *
 * Never throws. An audit write that fails must not take down the action it was
 * recording: a refund that the gateway already processed is a fact whether or
 * not the log line landed.
 */
import { run as dbRun, all as dbAll, get as dbGet } from './db.mjs';

/** Actions worth recording. Free-form strings are allowed; these are the ones used. */
export const ACTIONS = {
  SIGN_IN: 'sign-in',
  SIGN_IN_FAILED: 'sign-in.failed',
  SIGN_OUT: 'sign-out',
  ORDER_STATUS: 'order.status',
  ORDER_REFUND: 'order.refund',
  ORDER_SYNC: 'order.sync',
  ORDER_RECEIPT: 'order.receipt',
  STOCK_UPDATE: 'stock.update',
  MAIL_TEST: 'mail.test',
  MAIL_SEND: 'mail.send',
};

export function record({ actor = '', role = '', action, target = '', detail = '', ip = '' }) {
  try {
    dbRun(
      `INSERT INTO admin_actions (actor, role, action, target, detail, ip)
       VALUES (?,?,?,?,?,?)`,
      String(actor || ''),
      String(role || ''),
      String(action || 'unknown'),
      String(target || ''),
      String(detail || '').slice(0, 2000),
      String(ip || ''),
    );
  } catch (err) {
    console.error(`[audit] could not record ${action}: ${err.message}`);
  }
}

/** Most recent actions, newest first. */
export function recent(limit = 40) {
  try {
    return dbAll('SELECT * FROM admin_actions ORDER BY id DESC LIMIT ?', Math.min(200, Number(limit) || 40));
  } catch {
    return [];
  }
}

/** Everything that happened to one order, including refunds and sign-ins that named it. */
export function forOrder(orderNumber, limit = 40) {
  try {
    return dbAll(
      'SELECT * FROM admin_actions WHERE target = ? ORDER BY id DESC LIMIT ?',
      String(orderNumber),
      Math.min(200, Number(limit) || 40),
    );
  } catch {
    return [];
  }
}

/**
 * How many actions of a kind happened since a boundary, and by whom.
 * Used by the dashboard to show the day's activity without a chart library.
 */
export function summary() {
  try {
    const since = "datetime('now','-7 days')";
    return {
      total: dbGet('SELECT COUNT(*) AS n FROM admin_actions')?.n ?? 0,
      week: dbGet(`SELECT COUNT(*) AS n FROM admin_actions WHERE created_at >= ${since}`)?.n ?? 0,
      refunds: dbGet(`SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'order.refund'`)?.n ?? 0,
      signIns: dbGet(`SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'sign-in' AND created_at >= ${since}`)?.n ?? 0,
      failedSignIns: dbGet(`SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'sign-in.failed' AND created_at >= ${since}`)?.n ?? 0,
    };
  } catch {
    return { total: 0, week: 0, refunds: 0, signIns: 0, failedSignIns: 0 };
  }
}
