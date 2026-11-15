// main.ts — entrypoint: one process, one ephemeral port. Registers the
// port with the trial harness, then long-polls until the trial is done.

import { createApp } from './app.ts';
import { Store } from './store.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

if (!envUrl) {
  console.error('MAKEFUN_ENV_URL is required');
  process.exit(1);
}
if (!token) {
  console.error('MAKEFUN_SHOP_TOKEN is required');
  process.exit(1);
}

const store = new Store();
const server = createApp(store, token);

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    const registerRes = await fetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    if (!registerRes.ok) {
      console.error(`register failed: HTTP ${registerRes.status}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`register failed: ${(error as Error).message}`);
    process.exit(1);
  }

  // Long-poll until the trial harness says the run is done.
  while (true) {
    try {
      const doneRes = await fetch(`${envUrl}/done`);
      const doneBody = (await doneRes.json()) as { done?: boolean };
      if (doneBody.done === true) break;
    } catch {
      // Transient error: keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  server.close();
  process.exit(0);
});
