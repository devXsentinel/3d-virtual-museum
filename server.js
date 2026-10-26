const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const SITE_DIR = path.join(__dirname, 'site');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.glb': 'model/gltf-binary',
    '.woff2': 'font/woff2',
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
    // Enable CORS & disable restrictive caching
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    let reqPath = decodeURI(req.url.split('?')[0]);
    if (reqPath === '/' || reqPath === '/g/demo-museum' || reqPath === '/g/demo-museum/') {
        reqPath = '/index.html';
    }

    const filePath = path.join(SITE_DIR, reqPath);

    // Prevent directory traversal
    if (!filePath.startsWith(SITE_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Not Found');
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const totalSize = stats.size;

        // Support HTTP 206 Range requests for audio and video streaming
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
            const chunksize = (end - start) + 1;

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${totalSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType
            });
            fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': totalSize,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes'
            });
            fs.createReadStream(filePath).pipe(res);
        }
    });
});

server.listen(PORT, () => {
    console.log('===========================================================');
    console.log(` 3D Museum running at: http://localhost:${PORT}/`);
    console.log('===========================================================');
});
