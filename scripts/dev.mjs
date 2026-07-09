/**
 * Dev orchestrator: run the API server + Vite web app on automatically-allocated
 * ports, so it doesn't collide with other local servers.
 *
 * - Server port: PORT env if set, else 3000; falls forward to the next free port.
 * - Web port: WEB_PORT env if set, else 5173; falls forward to the next free port.
 * - The resolved server port is passed to Vite as SERVER_PORT so its dev proxy
 *   (/trpc, /api, /healthz) targets the same port. Both are logged.
 *
 * Production is unaffected: `npm start` binds the platform-provided PORT directly.
 */
import { spawn } from "node:child_process";
import net from "node:net";

async function findAvailablePort(preferred, host = "0.0.0.0", maxTries = 50) {
  for (let port = preferred; port < preferred + maxTries; port += 1) {
    if (await isFree(port, host)) {
      return port;
    }
  }
  throw new Error(`No free port found in ${preferred}..${preferred + maxTries}`);
}

function isFree(port, host) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, host);
  });
}

const serverPort = await findAvailablePort(Number(process.env.PORT) || 3000);
const webPort = await findAvailablePort(Number(process.env.WEB_PORT) || 5173);

console.log(`[dev] server → http://localhost:${serverPort}`);
console.log(`[dev] web    → http://localhost:${webPort} (proxying API to :${serverPort})\n`);

const children = [
  spawn("npm", ["run", "dev:server"], {
    stdio: "inherit",
    env: { ...process.env, PORT: String(serverPort) }
  }),
  spawn("npm", ["run", "dev:web", "--", "--port", String(webPort), "--strictPort"], {
    stdio: "inherit",
    env: { ...process.env, SERVER_PORT: String(serverPort) }
  })
];

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    child.kill("SIGINT");
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// If either process exits, tear down the other so we don't leave orphans.
for (const child of children) {
  child.on("exit", (code) => {
    shutdown();
    process.exitCode = code ?? 0;
  });
}
