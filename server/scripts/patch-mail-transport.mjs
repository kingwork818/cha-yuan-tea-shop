/**
 * Rewrite the SMTP transport in server/mail.mjs with a correct reply queue.
 *
 * The first draft resolved a single pending promise from the data handler, which
 * loses the server greeting (it often arrives before anyone calls read()) and
 * resolves instead of rejecting when the failure path fires. A queue plus explicit
 * resolve/reject is the small amount of state a line protocol actually needs.
 *
 * Run once:  node server/scripts/patch-mail-transport.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, '..', 'mail.mjs');

const lines = fs.readFileSync(FILE, 'utf8').split('\n');
const startIndex = lines.findIndex((l) => l.startsWith('class SmtpSession {'));
const composeIndex = lines.findIndex((l) => l.includes('Build the RFC 5322 message.'));
if (startIndex < 0 || composeIndex < 0) {
  console.error('could not locate the transport block');
  process.exit(1);
}
// The doc comment for compose() starts one line above its first text line.
const endIndex = composeIndex - 1;

const replacement = `class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.lines = [];
    /** Completed replies waiting to be read. */
    this.queue = [];
    this.waiter = null;
    this.waiterTimer = null;
    this.closedError = null;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    // A relay that never answers must not hang a checkout for a minute.
    socket.setTimeout(timeoutMs, () => this.onClose(new Error('SMTP timed out')));
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.onClose(err));
    socket.on('close', () => this.onClose(new Error('SMTP connection closed')));
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    for (;;) {
      const index = this.buffer.indexOf('\\r\\n');
      if (index === -1) return;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.lines.push(line);
      /*
       * A multi-line reply continues while the fourth character is a hyphen and
       * ends when it is a space. Reading only the first line of an EHLO response
       * would miss the AUTH capability list, which is how the first version of
       * this decided there was no way to authenticate.
       */
      if (line.length >= 4 && line[3] === ' ') {
        const text = this.lines.join('\\n');
        const code = Number(line.slice(0, 3));
        this.lines = [];
        this.push({ code, text });
      }
    }
  }

  push(reply) {
    if (!this.waiter) {
      this.queue.push(reply);
      return;
    }
    const { resolve, timer } = this.waiter;
    this.waiter = null;
    clearTimeout(timer);
    resolve(reply);
  }

  onClose(error) {
    if (this.closedError) return;
    this.closedError = error;
    if (this.waiter) {
      const { reject, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      reject(error);
    }
  }

  /** The next server reply, whether it already arrived or has yet to. */
  read() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('SMTP reply timed out'));
      }, timeoutMs);
      timer.unref?.();
      this.waiter = { resolve, reject, timer };
    });
  }

  write(line) {
    if (this.closedError) throw this.closedError;
    this.socket.write(\`\${line}\\r\\n\`);
  }

  /** Send a command and require a reply class (2xx or 3xx by default). */
  async command(line, { expect = [2, 3] } = {}) {
    this.write(line);
    const reply = await this.read();
    if (!expect.includes(Math.floor(reply.code / 100))) {
      throw new Error(\`SMTP \${line.split(' ')[0]} rejected: \${reply.text}\`);
    }
    return reply;
  }

  /** Upgrade a plain connection to TLS, keeping the same session state. */
  async startTls() {
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    const upgraded = await new Promise((resolve, reject) => {
      const socket = tls.connect({ socket: plain, servername: host }, () => resolve(socket));
      socket.once('error', reject);
    });
    this.buffer = '';
    this.lines = [];
    this.queue = [];
    this.closedError = null;
    this.attach(upgraded);
  }

  close() {
    try {
      this.socket.write('QUIT\\r\\n');
    } catch {
      /* the relay may already be gone; nothing to do */
    }
    this.socket.destroy();
  }
}

const timeoutMs = Number(process.env.SMTP_TIMEOUT_MS) || 20000;
const host = config.mail.host;

/** Open a connection, encrypted from the first byte on port 465. */
async function connect() {
  const { host: hostname, port, secure } = config.mail;
  const socket = secure
    ? await new Promise((resolve, reject) => {
        const s = tls.connect({ host: hostname, port, servername: hostname }, () => resolve(s));
        s.once('error', reject);
      })
    : await new Promise((resolve, reject) => {
        const s = net.connect({ host: hostname, port }, () => resolve(s));
        s.once('error', reject);
      });
  return new SmtpSession(socket);
}

/**
 * Authenticate.
 *
 * Only PLAIN and LOGIN are implemented: both are offered over TLS by Fastmail,
 * Google, Microsoft and every transactional provider. If a relay offers neither,
 * the error names what it did offer rather than guessing at a mechanism.
 */
async function authenticate(session) {
  const { user, pass } = config.mail;
  const ehlo = await session.command(\`EHLO \${heloName}\`, { expect: [2] });
  const mechanisms = (ehlo.text.match(/AUTH[ =]([^\\r\\n]+)/i)?.[1] || '').toUpperCase();

  if (mechanisms.includes('PLAIN')) {
    const token = Buffer.from(\`\\u0000\${user}\\u0000\${pass}\`, 'utf8').toString('base64');
    await session.command(\`AUTH PLAIN \${token}\`, { expect: [2] });
    return;
  }
  if (mechanisms.includes('LOGIN')) {
    await session.command('AUTH LOGIN', { expect: [3] });
    await session.command(Buffer.from(user, 'utf8').toString('base64'), { expect: [3] });
    await session.command(Buffer.from(pass, 'utf8').toString('base64'), { expect: [2] });
    return;
  }
  throw new Error(\`SMTP server offers no supported AUTH mechanism (offered: \${mechanisms || 'none'})\`);
}

const heloName = (config.mail.fromAddress.split('@')[1] || 'localhost').toLowerCase();

/** Deliver one already-composed message. Throws with the relay's own words. */
export async function deliver({ to, subject, text, html }) {
  if (!config.mail.enabled) throw new Error(\`mail is not configured (\${config.mail.reason})\`);

  const session = await connect();
  try {
    await session.read(); // 220 greeting, which may have arrived before we asked
    if (!config.mail.secure) {
      const caps = await session.command(\`EHLO \${heloName}\`, { expect: [2] });
      if (/STARTTLS/i.test(caps.text)) {
        await session.command('STARTTLS', { expect: [2] });
        await session.startTls();
      }
    }
    await authenticate(session);
    await session.command(\`MAIL FROM:<\${config.mail.fromAddress}>\`, { expect: [2] });
    await session.command(\`RCPT TO:<\${to}>\`, { expect: [2, 3] });
    await session.command('DATA', { expect: [3] });

    const message = compose({ to, subject, text, html });
    // Dot-stuffing: a body line of "." would otherwise end the DATA phase early.
    const wire = message.replace(/\\r?\\n/g, '\\r\\n').replace(/^\\./gm, '..');
    session.write(\`\${wire}\\r\\n.\`);
    const accepted = await session.read();
    if (Math.floor(accepted.code / 100) !== 2) {
      throw new Error(\`SMTP rejected the message: \${accepted.text}\`);
    }
    session.close();
    return { ok: true };
  } catch (err) {
    session.close();
    throw err;
  }
}
`;

const patched = [...lines.slice(0, startIndex), replacement, ...lines.slice(endIndex)].join('\n');
fs.writeFileSync(FILE, patched);
console.log(`  rewrote lines ${startIndex + 1}-${endIndex} of server/mail.mjs`);
