// Local preview that can never touch production: the database, eBay, email and password settings are blanked
// before .env is read (.env never overrides a variable that is already set), so the local embedded Postgres is used.
for (const k of ['DATABASE_URL', 'DASHBOARD_PASSWORD', 'EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET', 'EBAY_REFRESH_TOKEN', 'EBAY_RUNAME', 'EMAIL_USER', 'EMAIL_PASSWORD', 'INBOUND_TOKEN']) process.env[k] = '';
process.env.PORT = process.env.LOCAL_PORT || '3210';
await import('../src/server.js');
