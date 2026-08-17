/**
 * Block until a TCP port accepts a connection.
 *
 * `npm run dev` starts Vite and the API server together, but Vite is listening
 * in about a tenth of a second while tsx takes a couple of seconds. Any browser
 * tab already open on :5173 reconnects into that gap, the proxy has nothing to
 * forward to, and Vite prints an ECONNREFUSED/ECONNRESET stack trace that looks
 * like a fault but is only a race. Waiting removes the race rather than hiding
 * the symptom.
 *
 *   node scripts/wait-for-port.mjs 3001 [timeoutMs]
 *
 * Exits 0 either way: if the server never arrives, that is the server's error
 * to report, not a reason to refuse to start the UI.
 */
import { connect } from 'node:net';

const port = Number(process.argv[2] ?? 3001);
const timeoutMs = Number(process.argv[3] ?? 20_000);
const deadline = Date.now() + timeoutMs;

const reachable = () =>
  new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });

let announced = false;
while (Date.now() < deadline) {
  if (await reachable()) process.exit(0);
  if (!announced) {
    announced = true;
    process.stdout.write(`waiting for the API server on :${port} …\n`);
  }
  await new Promise((r) => setTimeout(r, 200));
}

process.stdout.write(`API server on :${port} did not come up; starting anyway\n`);
process.exit(0);
