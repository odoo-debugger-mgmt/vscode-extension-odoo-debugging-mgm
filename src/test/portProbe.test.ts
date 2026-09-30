/**
 * Before starting a version, its port is probed: something already listening
 * that is not this window's session is usually the same version started
 * from another window (design §9).
 */
import * as assert from 'assert';
import * as net from 'node:net';
import { isPortOpen } from '../services/server';

suite('Probing a server port', () => {
    test('a port something listens on is open; once closed, it is not', async () => {
        const server = net.createServer();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        const port = (server.address() as net.AddressInfo).port;

        assert.strictEqual(await isPortOpen(port), true);
        await new Promise<void>(resolve => server.close(() => resolve()));
        assert.strictEqual(await isPortOpen(port), false);
    });
});
