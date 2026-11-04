import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { handler } from './build/handler.js';

process.on('unhandledRejection', (reason) => {
	console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
	console.error('[uncaughtException]', err);
	process.exit(1); // undefined state after this — let the orchestrator restart
});

const port = process.env.PORT || '3000';
const host = process.env.HOST || '0.0.0.0';
const sslEnabled = process.env.SSL_ENABLED === 'true';

function requestListener(req, res) {
	if (req.method === 'GET' && req.url === '/health') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
		return;
	}
	handler(req, res);
}

const server = sslEnabled
	? https.createServer(
			{
				key: fs.readFileSync(process.env.SSL_KEY_PATH),
				cert: fs.readFileSync(process.env.SSL_CERT_PATH)
			},
			requestListener
		)
	: http.createServer(requestListener);

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.listen(port, host, () => {
	console.log(`Listening on ${sslEnabled ? 'https' : 'http'}://${host}:${port}`);
});
