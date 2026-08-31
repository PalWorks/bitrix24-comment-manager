# PHP reverse proxy (shared hosting)

For hosts where you cannot bind a public port or configure nginx, but you can serve
PHP and run a background Node process. Requests hit `proxy.php`, which forwards them
to the Node backend on localhost.

## Install

1. Copy `proxy.php` and `.htaccess` into the document root of the subdomain you want
   to serve the API from (for example the `api.` subdomain).
2. Edit the configuration block at the top of `proxy.php`:
   - `BACKEND` the localhost origin the Node process listens on
   - `APP_DIR` the backend directory of your checkout
   - `PROCESS_NAME` the pm2 process name
3. Start the backend once with pm2 and run `pm2 save`.

## Self healing

If the Node process is not answering, the proxy starts it via pm2 and retries the
request once. A lockfile prevents concurrent requests from spawning several restarts.

This is a convenience for constrained hosts. On any host where you control the web
server, put nginx or Caddy in front of Node instead and delete this directory.
