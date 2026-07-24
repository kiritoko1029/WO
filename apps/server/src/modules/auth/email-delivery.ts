import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface EmailDelivery {
  send(message: OutboundEmail): Promise<void>;
}

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
}

export function createConsoleEmailDelivery(
  log: (line: string) => void = console.info,
): EmailDelivery {
  return {
    async send(message) {
      log(
        `[email] to=${message.to} subject=${JSON.stringify(message.subject)} body=${JSON.stringify(message.text)}`,
      );
    },
  };
}

function encodeSubject(value: string): string {
  if (/^[\x20-\x7e]*$/u.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function quoteAddress(value: string): string {
  return value.replaceAll(/[\r\n]/gu, '');
}

async function readSmtpResponse(
  socket: NodeJS.ReadableStream,
): Promise<{ code: number; lines: string[] }> {
  let buffer = '';
  while (true) {
    const chunk: Buffer | null = await new Promise((resolve, reject) => {
      const onData = (data: Buffer | string) => {
        cleanup();
        resolve(typeof data === 'string' ? Buffer.from(data) : data);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onEnd = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => {
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('end', onEnd);
      };
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('end', onEnd);
    });
    if (chunk === null) {
      throw new Error('SMTP connection closed');
    }
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    const last = lines.at(-1)!;
    if (/^\d{3}-/u.test(last)) continue;
    const match = /^(\d{3})(?: |$)/u.exec(last);
    if (match === null) continue;
    return { code: Number(match[1]), lines };
  }
}

async function writeSmtp(
  socket: NodeJS.WritableStream,
  line: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(`${line}\r\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function expectCode(
  socket: NodeJS.ReadableStream,
  expected: number | readonly number[],
): Promise<void> {
  const response = await readSmtpResponse(socket);
  const allowed = typeof expected === 'number' ? [expected] : expected;
  if (!allowed.includes(response.code)) {
    throw new Error(
      `SMTP unexpected response ${response.code}: ${response.lines.join(' | ')}`,
    );
  }
}

export function createSmtpEmailDelivery(settings: SmtpSettings): EmailDelivery {
  return {
    async send(message) {
      const socket = settings.secure
        ? tlsConnect({
            host: settings.host,
            port: settings.port,
            servername: settings.host,
          })
        : createConnection({ host: settings.host, port: settings.port });

      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('secureConnect', () => resolve());
        socket.once('error', reject);
      });

      try {
        await expectCode(socket, 220);
        await writeSmtp(socket, `EHLO wo.local`);
        await expectCode(socket, 250);

        let active: NodeJS.ReadWriteStream = socket;
        if (!settings.secure) {
          await writeSmtp(socket, 'STARTTLS');
          await expectCode(socket, 220);
          active = tlsConnect({
            socket,
            servername: settings.host,
          });
          await new Promise<void>((resolve, reject) => {
            active.once('secureConnect', () => resolve());
            active.once('error', reject);
          });
          await writeSmtp(active, `EHLO wo.local`);
          await expectCode(active, 250);
        }

        if (settings.user.length > 0) {
          await writeSmtp(active, 'AUTH LOGIN');
          await expectCode(active, 334);
          await writeSmtp(
            active,
            Buffer.from(settings.user, 'utf8').toString('base64'),
          );
          await expectCode(active, 334);
          await writeSmtp(
            active,
            Buffer.from(settings.pass, 'utf8').toString('base64'),
          );
          await expectCode(active, 235);
        }

        await writeSmtp(active, `MAIL FROM:<${quoteAddress(settings.from)}>`);
        await expectCode(active, 250);
        await writeSmtp(active, `RCPT TO:<${quoteAddress(message.to)}>`);
        await expectCode(active, [250, 251]);
        await writeSmtp(active, 'DATA');
        await expectCode(active, 354);
        const body = [
          `From: ${quoteAddress(settings.from)}`,
          `To: ${quoteAddress(message.to)}`,
          `Subject: ${encodeSubject(message.subject)}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          message.text.replaceAll(/^\./gmu, '..'),
          '.',
        ].join('\r\n');
        await writeSmtp(active, body);
        await expectCode(active, 250);
        await writeSmtp(active, 'QUIT');
      } finally {
        socket.destroy();
      }
    },
  };
}

export function createEmailDelivery(smtp: SmtpSettings | null): EmailDelivery {
  if (smtp === null) return createConsoleEmailDelivery();
  return createSmtpEmailDelivery(smtp);
}
