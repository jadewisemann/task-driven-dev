import { hostname, networkInterfaces } from 'node:os';

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

/** Addresses a phone could reach: every non-internal IPv4 interface (LAN, Tailscale 100.x, VPN…). */
function reachableAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, address: a.address, tailscale: a.address.startsWith('100.') || /tailscale|utun/i.test(name) });
    }
  }
  // Link-local (169.254.x) addresses are rarely reachable from a phone: only used as a last resort.
  const usable = out.filter((a) => !a.address.startsWith('169.254.'));
  // Tailscale first: it is encrypted and works from anywhere; LAN only on the same network.
  return (usable.length ? usable : out).sort((x, y) => Number(y.tailscale) - Number(x.tailscale));
}

export const PAIRING_WARNING =
  'Links contain a one-time code (valid 10 minutes, single use). Plain LAN addresses are unencrypted HTTP: use them only on networks you trust — Tailscale addresses are encrypted.';

/**
 * Pairing info for the mobile app and other browsers. Links carry a one-time
 * code (never the long-lived token); the device exchanges it via POST /api/pair.
 *   app: todo-devs://pair?url=…&code=…&name=…
 *   web: http://host:port/#pair=CODE
 * @param {{host: string, port: number, token: string|null}} daemon
 * @param {{code?: string, expiresAt?: string, publicHost?: string}} [opts]
 */
export function pairingInfo(daemon, { code, expiresAt, publicHost } = {}) {
  if (!daemon.token || LOOPBACK.includes(daemon.host)) {
    return {
      enabled: false,
      reason: 'The server only listens on this computer. Restart it with `todo-devs serve --host 0.0.0.0` (an access token is created and kept in auth.json).',
      links: [],
    };
  }
  const bound = daemon.host === '0.0.0.0' || daemon.host === '::' ? null : daemon.host;
  const targets = publicHost ? [{ iface: 'custom', address: publicHost }] : bound ? [{ iface: 'bound', address: bound }] : reachableAddresses();
  const name = hostname().split('.')[0];
  const links = targets.map((t) => {
    const url = `http://${t.address.includes(':') && !t.address.startsWith('[') ? `[${t.address}]` : t.address}:${daemon.port}`;
    const q = new URLSearchParams({ url, code, name });
    return { label: `${t.iface}${t.tailscale ? ' (Tailscale)' : ''} ${t.address}`, url, encrypted: Boolean(t.tailscale), deepLink: `todo-devs://pair?${q}`, web: `${url}/#pair=${code}` };
  });
  return { enabled: links.length > 0, reason: links.length ? null : 'No network interface found', name, code, expiresAt, warning: PAIRING_WARNING, links };
}
