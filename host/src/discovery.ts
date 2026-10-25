import { createSocket, type Socket } from 'node:dgram';

export const DISCOVERY_PORT = 7301;
export const DISCOVERY_REQUEST = 'KRAKEN_HUB_DISCOVER';

/**
 * Answers "where is the counter?" broadcasts from customer PCs on the local network,
 * so a freshly installed client finds the host without anyone typing an IP address.
 * The reply says which port the host's web server listens on; the PC takes the
 * host's address from where the reply came from.
 */
export function startDiscovery(opts: { httpPort: number; name: () => string; onError?: (err: Error) => void }): Socket {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (msg, rinfo) => {
    if (msg.toString('utf8').trim() !== DISCOVERY_REQUEST) return;
    const reply = Buffer.from(JSON.stringify({ app: 'kraken-hub', name: opts.name(), port: opts.httpPort }));
    socket.send(reply, rinfo.port, rinfo.address);
  });
  socket.on('error', (err) => opts.onError?.(err));
  socket.bind(DISCOVERY_PORT);
  return socket;
}
