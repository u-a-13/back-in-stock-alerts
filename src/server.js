'use strict';

const { config, missingRequired } = require('./config');
const { openDb, makeStore } = require('./db');
const { makeStockClient, makeMailer } = require('./clients');
const { makeNotifier } = require('./notifier');
const { makeApp } = require('./app');

const missing = missingRequired();
if (missing.length) console.warn(`Warning: missing env var(s): ${missing.join(', ')}. Those features will fail until they are set.`);

const store = makeStore(openDb(config.dataDir));
const stock = makeStockClient({ url: config.stockApiUrl, key: config.stockApiKey });
const mailer = makeMailer({ baseUrl: config.resendBaseUrl, key: config.resendApiKey, from: config.emailFrom });
const notifier = makeNotifier({ store, stock, mailer, config });
const admin = store.adminPassword(config.adminPassword);
const server = makeApp({ store, stock, notifier, config, adminPassword: admin.password });

server.listen(config.port, () => {
  console.log(`Back-in-stock alerts listening on :${config.port}`);
  console.log(admin.generated
    ? `Admin: /admin  user "admin", password "${admin.password}" (generated and saved; set ADMIN_PASSWORD to choose your own)`
    : 'Admin: /admin  password from ADMIN_PASSWORD');
  notifier.start();
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal}: finishing in-flight sends, then exiting`);
  server.close();
  await notifier.stop();
  store.db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
