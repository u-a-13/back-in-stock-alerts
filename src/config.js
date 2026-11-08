'use strict';

const path = require('node:path');

function trimSlash(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

const config = {
  port: Number(process.env.PORT) || 3000,

  // Required by the brief.
  stockApiUrl: trimSlash(process.env.STOCK_API_URL),
  stockApiKey: process.env.STOCK_API_KEY || '',
  resendApiKey: process.env.RESEND_API_KEY || '',
  resendBaseUrl: trimSlash(process.env.RESEND_BASE_URL || 'https://api.resend.com'),
  webhookSecret: process.env.WEBHOOK_SECRET || '',

  // Optional. Everything works without these.
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  emailFrom: process.env.EMAIL_FROM || 'Restock Alerts <alerts@restock-alerts.dev>',
  storeName: process.env.STORE_NAME || 'Our store',
  productUrlTemplate: process.env.PRODUCT_URL_TEMPLATE || '', // e.g. https://shop.example.com/products/{sku}
  sweepSeconds: Number(process.env.SWEEP_INTERVAL_SECONDS) || 60,
};

function missingRequired() {
  return ['STOCK_API_URL', 'STOCK_API_KEY', 'RESEND_API_KEY', 'WEBHOOK_SECRET'].filter((k) => !process.env[k]);
}

module.exports = { config, missingRequired };
