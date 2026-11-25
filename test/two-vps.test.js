import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { validateConfig, renderRules, shellQuote, sshArgs } from '../deploy/lib.js';
import { endpointLines, replaceEndpoints, publishedPort } from '../deploy/remote/exit.mjs';
import { resolveEndpoint, parsePort } from '../src/builders/endpoint.js';
import { buildAmneziaConfig, encodeVpn, decodeVpn } from '../src/builders/vpnLink.js';

const example = JSON.parse(readFileSync(new URL('../deploy/two-vps.example.json', import.meta.url), 'utf8'));

test('public endpoint overrides internal port consistently in all Amnezia fields', async () => {
  // Никаких реальных секретов/подключений; dotenv не переопределяет эти значения.
  process.env.BOT_TOKEN = 'test-token';
  process.env.ADMIN_IDS = '1';
  process.env.ENDPOINT_PORT = '443';
  const { buildClientConfig } = await import('../src/builders/wgquick.js');
  const ep = resolveEndpoint('203.0.113.10', 443, 51820);
  const conf = buildClientConfig({ clientIp: '10.8.1.2', clientPrivKey: 'private',
    obfuscation: [], serverPubKey: 'public', pskKey: 'psk', endpoint: ep.endpoint });
  const artifact = decodeVpn(encodeVpn(buildAmneziaConfig({ hostName: ep.host, port: ep.port,
    obfuscation: [], clientConfigText: conf, mtu: '1280' })));
  const awg = artifact.containers[0].awg;
  assert.equal(awg.port, '443');
  assert.equal(JSON.parse(awg.last_config).port, 443);
  assert.match(JSON.parse(awg.last_config).config, /Endpoint = 203\.0\.113\.10:443/);
  assert.doesNotMatch(conf, /51820/);
});

test('single-server default remains ListenPort; invalid override cannot be injected', () => {
  assert.equal(resolveEndpoint('vpn.example.org', null, '51820').endpoint, 'vpn.example.org:51820');
  assert.equal(resolveEndpoint('2001:db8::1', 443, 51820).endpoint, '[2001:db8::1]:443');
  for (const value of ['0', '-1', '65536', '443\nPostUp=bad', '1.5', '1e3', '']) {
    assert.throws(() => parsePort(value));
  }
  assert.throws(() => resolveEndpoint('', 443, 51820));
});

test('Docker mapped host port is used, not container port or IPv6 binding', () => {
  assert.equal(publishedPort({ '51820/udp': [{ HostIp: '0.0.0.0', HostPort: '42000' },
    { HostIp: '::', HostPort: '42000' }] }, 51820, example.exit.host), 42000);
  assert.equal(publishedPort({ '51820/udp': [{ HostIp: example.exit.host, HostPort: '42000' }] }, 51820, example.exit.host), 42000);
  assert.throws(() => publishedPort({ '51820/udp': [{ HostIp: '127.0.0.1', HostPort: '51820' }] }, 51820, example.exit.host));
  assert.throws(() => publishedPort({ '51820/tcp': [{ HostIp: '0.0.0.0', HostPort: '51820' }] }, 51820, example.exit.host));
  assert.throws(() => publishedPort({ '51820/udp': [{ HostIp: '0.0.0.0', HostPort: '123' },
    { HostIp: example.exit.host, HostPort: '456' }] }, 51820, example.exit.host));
});

test('endpoint update and rollback preserve token changes and unrelated .env fields', () => {
  const original = '# comment\r\nBOT_TOKEN=old\r\nENDPOINT_HOST="198.51.100.20"\r\nexport ENDPOINT_PORT=51820\r\nDNS1=1.1.1.1\r\n';
  const before = endpointLines(original);
  const applied = ['ENDPOINT_HOST=203.0.113.10', 'ENDPOINT_PORT=443'];
  const updated = replaceEndpoints(original, applied);
  assert.deepEqual(endpointLines(updated), applied);
  assert.equal(replaceEndpoints(updated, applied), updated);
  const restored = replaceEndpoints(updated.replace('BOT_TOKEN=old', 'BOT_TOKEN=new'), before);
  assert.match(restored, /BOT_TOKEN=new/);
  assert.match(restored, /DNS1=1.1.1.1/);
  assert.deepEqual(endpointLines(restored), before);
  assert.doesNotMatch(JSON.stringify(before), /BOT_TOKEN/);
  assert.deepEqual(endpointLines(replaceEndpoints(updated, [])), []);
});

test('reject unsafe inventory before SSH; enforce host key checks', () => {
  assert.throws(() => validateConfig({ ...example, entry: { ...example.entry, host: 'x; reboot' } }));
  assert.throws(() => validateConfig({ ...example, exit: { ...example.exit, host: example.entry.host } }));
  assert.throws(() => validateConfig({ ...example, exit: { ...example.exit, botDir: '/root/../etc' } }));
  assert.throws(() => validateConfig({ ...example, exit: { ...example.exit, container: '--privileged' } }));
  assert.throws(() => validateConfig({ ...example, exit: { ...example.exit, botService: 'bot;reboot.service' } }));
  assert.ok(sshArgs(validateConfig(example).entry, 'true').includes('StrictHostKeyChecking=yes'));
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('relay rules have one fixed UDP target, SNAT, no INPUT changes or global flush', () => {
  const rules = renderRules(example, 42000);
  assert.match(rules, /udp dport 51820 counter dnat to 198\.51\.100\.20:42000/);
  assert.match(rules, /ct status dnat ip daddr 198\.51\.100\.20 udp dport 42000 counter masquerade/);
  assert.match(rules, /hook forward priority filter; policy drop/);
  assert.match(rules, /ct original ip daddr 203\.0\.113\.10 ct original proto-dst 51820/);
  assert.doesNotMatch(rules, /hook input|flush ruleset|0\.0\.0\.0\/0/);
  assert.throws(() => renderRules(example, '123;flush ruleset'));
});

test('default deploy is offline plan; works without ssh in PATH', () => {
  const result = spawnSync(process.execPath, ['deploy/two-vps.js', 'deploy/two-vps.example.json'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /План не подключается к VPS/);
});
