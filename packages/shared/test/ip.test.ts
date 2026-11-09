import { describe, expect, it } from 'vitest';
import { classifyIp, parseIpv6 } from '../src/index';

describe('classifyIp — IPv4', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['0.255.1.2', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.0', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['100.128.0.0', 'public'],
    ['100.63.255.255', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link_local'],
    ['172.15.255.255', 'public'],
    ['172.16.0.0', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.0', 'public'],
    ['192.0.0.8', 'reserved'],
    ['192.0.2.1', 'documentation'],
    ['192.88.99.1', 'reserved'],
    ['192.168.1.1', 'private'],
    ['198.17.255.255', 'public'],
    ['198.18.0.1', 'benchmark'],
    ['198.19.255.255', 'benchmark'],
    ['198.20.0.0', 'public'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.254', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['223.255.255.255', 'public'],
  ])('%s → %s', (ip, kind) => {
    expect(classifyIp(ip)).toBe(kind);
  });

  it.each([
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '01.2.3.4',
    '0x7f.0.0.1',
    '2130706433',
    ' 1.2.3.4',
    '',
  ])('formas não canônicas não são IP aqui: %j', (ip) => {
    expect(classifyIp(ip)).toBe('invalid');
  });
});

describe('classifyIp — IPv6', () => {
  it.each([
    ['::', 'unspecified'],
    ['[::]', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['0:0:0:0:0:ffff:7f00:0001', 'loopback'],
    ['::FFFF:127.0.0.1', 'loopback'],
    ['0000:0000:0000:0000:0000:ffff:127.0.0.1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:a9fe:a9fe', 'link_local'],
    ['::ffff:8.8.8.8', 'public'],
    ['::ffff:0:127.0.0.1', 'loopback'],
    ['::127.0.0.1', 'reserved'],
    ['::8.8.8.8', 'reserved'],
    ['::7f00:1', 'reserved'],
    ['64:ff9b::127.0.0.1', 'loopback'],
    ['64:ff9b::8.8.8.8', 'public'],
    ['64:ff9b:1::1', 'private'],
    ['100::1', 'reserved'],
    ['2001:db8::1', 'documentation'],
    ['2001:2::1', 'benchmark'],
    ['2001::1', 'reserved'],
    ['2002:7f00:1::', 'loopback'],
    ['2002:0808:0808::1', 'public'],
    ['3fff::1', 'documentation'],
    ['fc00::1', 'unique_local'],
    ['fd12:3456:789a::1', 'unique_local'],
    ['fe80::1', 'link_local'],
    ['fe80::1%eth0', 'link_local'],
    ['febf::1', 'link_local'],
    ['fec0::1', 'private'],
    ['ff02::1', 'multicast'],
    ['ff05::2', 'multicast'],
    ['2606:4700:4700::1111', 'public'],
    ['2001:4860:4860::8888', 'public'],
    ['4000::1', 'reserved'],
    ['::2', 'reserved'],
  ])('%s → %s', (ip, kind) => {
    expect(classifyIp(ip)).toBe(kind);
  });

  it.each([
    ':::',
    '1::2::3',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7',
    '12345::',
    'g::1',
    '::ffff:256.0.0.1',
    '::ffff:1.2.3',
    '1:2:3:4:5:6:7:1.2.3.4',
    '1:2:3:4:5:6:7:8::',
    'fe80::1%',
    '[::1',
  ])('IPv6 inválido: %s', (ip) => {
    expect(classifyIp(ip)).toBe('invalid');
  });

  it('parseIpv6 expande "::" e IPv4 no fim', () => {
    expect(parseIpv6('1::2')).toEqual([1, 0, 0, 0, 0, 0, 0, 2]);
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6('1:2:3:4:5:6:1.2.3.4')).toEqual([1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
    expect(parseIpv6('1:2:3:4:5:6:7::')).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
  });
});
