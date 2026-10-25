import { createSocket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { DISCOVERY_PORT, DISCOVERY_REQUEST, startDiscovery } from './discovery.js';

describe('PC discovery', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it('answers a discovery request with the host port and venue name', async () => {
    const server = startDiscovery({ httpPort: 7300, name: () => 'Kraken Lounge' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const client = createSocket('udp4');
    close = () => {
      server.close();
      client.close();
    };
    const reply = new Promise<{ app: string; name: string; port: number }>((resolve) =>
      client.on('message', (msg) => resolve(JSON.parse(msg.toString()) as { app: string; name: string; port: number })),
    );
    client.send(DISCOVERY_REQUEST, DISCOVERY_PORT, '127.0.0.1');
    expect(await reply).toEqual({ app: 'kraken-hub', name: 'Kraken Lounge', port: 7300 });
  });
});
