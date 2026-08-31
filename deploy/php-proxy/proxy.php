<?php
/**
 * Reverse proxy: forwards all requests to a Node.js backend on localhost.
 * Self-healing: if the backend is down, triggers a pm2 start via shell_exec and
 * retries the request once.
 *
 * Configure the three values below for your host.
 */

// ---- configuration ----------------------------------------------------------
define('BACKEND', 'http://127.0.0.1:3001');            // where Node listens
$APP_DIR      = getenv('APP_DIR') ?: '~/apps/b24-backend/backend';
$PROCESS_NAME = getenv('PROCESS_NAME') ?: 'b24-backend';
// -----------------------------------------------------------------------------

$PM2_CMD = 'export NVM_DIR="$HOME/.nvm"'
    . ' && . "$NVM_DIR/nvm.sh"'
    . ' && pm2 describe ' . escapeshellarg($PROCESS_NAME) . ' > /dev/null 2>&1'
    . ' || (cd ' . $APP_DIR . ' && pm2 start dist/server.js --name '
    . escapeshellarg($PROCESS_NAME) . ' && pm2 save)';

function doProxy(): array {
    global $_SERVER;
    $method = $_SERVER['REQUEST_METHOD'];
    $path   = $_SERVER['REQUEST_URI'];
    $target = BACKEND . $path;

    $ch = curl_init($target);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER         => true,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 5,
    ]);

    $body = file_get_contents('php://input');
    if ($body !== '') {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }

    $fwdHeaders = [];
    foreach (getallheaders() as $name => $value) {
        $lower = strtolower($name);
        if (in_array($lower, ['content-type','content-length','authorization','x-forwarded-for','accept','origin'])) {
            $fwdHeaders[] = "$name: $value";
        }
    }
    $fwdHeaders[] = 'X-Forwarded-For: ' . ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    $fwdHeaders[] = 'X-Forwarded-Proto: https';
    curl_setopt($ch, CURLOPT_HTTPHEADER, $fwdHeaders);

    $response   = curl_exec($ch);
    $statusCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $errno      = curl_errno($ch);
    $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);

    return [$response, $statusCode, $errno, $headerSize];
}

$lockfile = sys_get_temp_dir() . '/b24_restart.lock';

[$response, $statusCode, $errno, $headerSize] = doProxy();

// Connection refused means Node.js is not running. Trigger PM2 restart once.
// Use a lockfile so concurrent requests do not spawn multiple restarts.
if (($errno === CURLE_COULDNT_CONNECT || $statusCode === 0) && !file_exists($lockfile)) {
    file_put_contents($lockfile, (string) time());
    shell_exec('bash -lc ' . escapeshellarg($PM2_CMD) . ' > /dev/null 2>&1 &');
    sleep(5);
    @unlink($lockfile);
    [$response, $statusCode, $errno, $headerSize] = doProxy();
}

$responseHeaders = is_string($response) ? substr($response, 0, $headerSize) : '';
$responseBody    = is_string($response) ? substr($response, $headerSize) : '';

http_response_code($statusCode ?: 502);

foreach (explode("\r\n", $responseHeaders) as $header) {
    if (preg_match('/^(Content-Type|Cache-Control|Access-Control-[^:]+):/i', $header)) {
        header($header);
    }
}

echo $responseBody;
