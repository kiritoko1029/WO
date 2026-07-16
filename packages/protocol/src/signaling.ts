import { z } from 'zod';

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SIGNAL_TICKET_BYTES = 32;
const SIGNAL_TICKET_LENGTH = 43;

const decodeBase64url = (value: string): Uint8Array | null => {
  const decoded = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let bitCount = 0;
  let byteIndex = 0;

  for (const character of value) {
    const sextet = BASE64URL_ALPHABET.indexOf(character);
    if (sextet === -1) {
      return null;
    }

    accumulator = (accumulator << 6) | sextet;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      decoded[byteIndex] = (accumulator >>> bitCount) & 0xff;
      byteIndex += 1;
      accumulator &= (1 << bitCount) - 1;
    }
  }

  return decoded.subarray(0, byteIndex);
};

const encodeBase64url = (value: Uint8Array): string => {
  let encoded = '';
  let accumulator = 0;
  let bitCount = 0;

  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;
    while (bitCount >= 6) {
      bitCount -= 6;
      encoded += BASE64URL_ALPHABET[(accumulator >>> bitCount) & 0x3f];
      accumulator &= (1 << bitCount) - 1;
    }
  }

  if (bitCount > 0) {
    encoded += BASE64URL_ALPHABET[(accumulator << (6 - bitCount)) & 0x3f];
  }

  return encoded;
};

const signalTicketSchema = z.string().refine((value) => {
  if (
    value.length !== SIGNAL_TICKET_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return false;
  }

  const decoded = decodeBase64url(value);
  return (
    decoded !== null &&
    decoded.byteLength === SIGNAL_TICKET_BYTES &&
    encodeBase64url(decoded) === value
  );
}, 'Invalid signaling ticket');

export const signalTicketResponseSchema = z
  .object({
    ticket: signalTicketSchema,
    expiresInSeconds: z.literal(30),
  })
  .strict();

export type SignalTicketResponse = z.infer<typeof signalTicketResponseSchema>;
