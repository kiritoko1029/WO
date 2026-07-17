import type { NetworkInterfaceInfo } from 'node:os';

import { describe, expect, test } from 'vitest';

import { selectPrivateIpv4Address } from '../src/lite/lite-room-service.ts';

const address = (
  value: string,
  options: { readonly internal?: boolean } = {},
): NetworkInterfaceInfo => ({
  address: value,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal: options.internal ?? false,
  cidr: `${value}/24`,
});

describe('LAN advertise address selection', () => {
  test('prefers physical interfaces and permits an explicit enumerated address', () => {
    const interfaces = {
      docker0: [address('172.17.0.1')],
      en0: [address('192.168.1.20')],
      lo0: [address('127.0.0.1', { internal: true })],
    };

    expect(selectPrivateIpv4Address(interfaces)).toBe('192.168.1.20');
    expect(selectPrivateIpv4Address(interfaces, '172.17.0.1')).toBe(
      '172.17.0.1',
    );
    expect(() => selectPrivateIpv4Address(interfaces, '192.168.1.99')).toThrow(
      'must be an available private IPv4 address',
    );
    expect(() => selectPrivateIpv4Address(interfaces, '8.8.8.8')).toThrow(
      'must be an available private IPv4 address',
    );
  });
});
