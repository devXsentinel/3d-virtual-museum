const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
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

// Setup Socket.IO for real-time multiplayer rooms
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling']
});

const rooms = new Map();

function getRoom(name) {
    if (!rooms.has(name)) {
        rooms.set(name, {
            name,
            occupants: new Map(),
            seats: new Map(),
            seq: 0
        });
    }
    return rooms.get(name);
}

io.on('connection', (socket) => {
    const roomName = (socket.handshake.query && socket.handshake.query.room) || 'demo-museum';
    socket.join(roomName);
    const room = getRoom(roomName);

    // Send initial session state
    socket.emit('session_state', {
        occupants: Array.from(room.occupants.values()),
        capacity: 10,
        full: false
    });

    socket.on('join', (payload) => {
        const visitor = {
            id: socket.id,
            username: payload.username || 'Visitor',
            character: payload.character || 'kai',
            skin: payload.skin || null,
            appearance: payload.appearance || null,
            x: 0,
            y: 0,
            z: -6.5,
            yaw: 0,
            speed: 0,
            seat: null
        };
        room.occupants.set(socket.id, visitor);

        // Acknowledge join to current player
        socket.emit('join_ok', {
            ok: true,
            you: visitor,
            visitors: Array.from(room.occupants.values()).filter(v => v.id !== socket.id),
            token: socket.id,
            capacity: 10
        });

        // Notify other visitors in the same room
        socket.to(roomName).emit('visitor_joined', visitor);
        console.log(`[Multiplayer] ${visitor.username} (${visitor.character}) joined room: ${roomName} (Total: ${room.occupants.size})`);
    });

    // Real-time movement & position synchronization
    socket.on('state', (state) => {
        const visitor = room.occupants.get(socket.id);
        if (visitor) {
            visitor.x = state.x;
            visitor.y = state.y;
            visitor.z = state.z;
            visitor.yaw = state.yaw;
            visitor.speed = state.speed;
            visitor.seat = state.seat;
        }
        socket.to(roomName).emit('visitor_state', {
            id: socket.id,
            ...state
        });
    });

    // Chat
    socket.on('chat', (data) => {
        if (!data || !data.text) return;
        io.to(roomName).emit('visitor_chat', {
            id: socket.id,
            text: data.text
        });
    });

    // Emotes / reactions
    socket.on('emote', (data) => {
        const emote = typeof data === 'string' ? data : (data?.id || data?.emote);
        if (!emote) return;
        io.to(roomName).emit('visitor_emote', {
            id: socket.id,
            emote: emote
        });
    });

    // Character model or color customization
    socket.on('character', (data) => {
        const visitor = room.occupants.get(socket.id);
        if (visitor && data) {
            if (data.character) visitor.character = data.character;
            if (data.skin) visitor.skin = data.skin;
            if (data.appearance) visitor.appearance = data.appearance;
        }
        socket.to(roomName).emit('visitor_character', {
            id: socket.id,
            ...data
        });
    });

    // WebRTC Direct P2P signaling
    socket.on('rtc_signal', (payload) => {
        if (payload && payload.to) {
            io.to(payload.to).emit('rtc_signal', {
                from: socket.id,
                kind: payload.kind,
                data: payload.data
            });
        }
    });

    // Bench seat reservation
    socket.on('seat_claim', (data, callback) => {
        const seatId = data && data.seat;
        if (!seatId) {
            if (typeof callback === 'function') callback({ ok: false, reason: 'invalid_seat' });
            return;
        }

        if (!room.seats) room.seats = new Map();

        const currentOccupant = room.seats.get(seatId);
        if (currentOccupant && currentOccupant !== socket.id && room.occupants.has(currentOccupant)) {
            if (typeof callback === 'function') {
                callback({ ok: false, reason: 'Someone else took that seat.' });
            }
            return;
        }

        const token = `seat_${socket.id}_${Date.now()}`;
        room.seats.set(seatId, socket.id);
        const visitor = room.occupants.get(socket.id);
        if (visitor) {
            visitor.seat = seatId;
        }

        if (typeof callback === 'function') {
            callback({
                ok: true,
                seat: seatId,
                token: token
            });
        }
    });

    // Seat release (standing up)
    socket.on('seat_release', (data) => {
        const seatId = data && data.seat;
        if (!seatId || !room.seats) return;
        if (room.seats.get(seatId) === socket.id) {
            room.seats.delete(seatId);
            const visitor = room.occupants.get(socket.id);
            if (visitor) {
                visitor.seat = null;
            }
        }
    });

    // Network latency ping
    socket.on('net_ping', (pingId) => {
        socket.emit('net_pong', pingId);
    });

    // Visitor disconnect
    socket.on('disconnect', () => {
        if (room.occupants.has(socket.id)) {
            const visitor = room.occupants.get(socket.id);
            room.occupants.delete(socket.id);
            if (room.seats) {
                for (const [seatId, occupantId] of room.seats.entries()) {
                    if (occupantId === socket.id) {
                        room.seats.delete(seatId);
                    }
                }
            }
            io.to(roomName).emit('visitor_left', { id: socket.id });
            console.log(`[Multiplayer] ${visitor?.username || socket.id} left room: ${roomName} (Remaining: ${room.occupants.size})`);
        }
    });
});

if (require.main === module) {
    server.listen(PORT, () => {
        console.log('===========================================================');
        console.log(` 3D Museum + Multiplayer running at: http://localhost:${PORT}/`);
        console.log('===========================================================');
    });
}

module.exports = server;
