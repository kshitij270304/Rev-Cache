import express from 'express';
import axios from 'axios';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

// --- CONFIGURATION ---
const NODE_ID = process.env.NODE_ID || `node-${Math.floor(Math.random() * 1000)}`;
const REST_PORT = parseInt(process.env.PORT || '3001', 10);
const GRPC_PORT = REST_PORT + 1000; // Offset gRPC port
const NODE_URL = process.env.NODE_URL || `http://localhost:${REST_PORT}`;
const GRPC_URL = process.env.GRPC_URL || `localhost:${GRPC_PORT}`;
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://localhost:3000';

// --- EXPRESS APP (Admin & Simulation only) ---
const app = express();
app.use(express.json());

// --- IN-MEMORY STORAGE & STATE ---
interface CacheItem {
    value: any;
    expiresAt: number | null;
}
const store = new Map<string, CacheItem>();

let metrics = { hits: 0, misses: 0 };
let isCrashed = false; // Crash simulation flag

// --- REST Endpoints (Simulation) ---
app.post('/internal/crash', (req, res) => {
    isCrashed = true;
    console.log(`[${NODE_ID}] Simulated CRASH activated. gRPC will reject requests.`);
    res.send({ status: 'crashed' });
});

app.post('/internal/revive', (req, res) => {
    isCrashed = false;
    console.log(`[${NODE_ID}] Simulated REVIVAL activated. gRPC resuming.`);
    res.send({ status: 'revived' });
});

// ---------------------------------------------------------
// gRPC SERVER IMPLEMENTATION
// ---------------------------------------------------------
const PROTO_PATH = path.resolve(__dirname, '../proto/cache.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const cacheProto = grpc.loadPackageDefinition(packageDefinition).cache as any;

const grpcServer = new grpc.Server();

grpcServer.addService(cacheProto.CacheService.service, {
    Get: (call: any, callback: any) => {
        if (isCrashed) return callback({ code: grpc.status.UNAVAILABLE, message: 'Node is down' });

        const key = call.request.key;
        const item = store.get(key);

        if (!item || (item.expiresAt !== null && Date.now() > item.expiresAt)) {
            if (item) store.delete(key);
            metrics.misses++;
            return callback(null, { found: false, value: "" });
        }

        metrics.hits++;
        callback(null, { found: true, value: JSON.stringify(item.value) });
    },

    Put: (call: any, callback: any) => {
        if (isCrashed) return callback({ code: grpc.status.UNAVAILABLE, message: 'Node is down' });

        const { key, value, ttl } = call.request;
        const expiresAt = ttl > 0 ? Date.now() + ttl : null;
        
        store.set(key, { value: JSON.parse(value), expiresAt });
        console.log(`[${NODE_ID}] (gRPC) Saved key: ${key}`);
        
        callback(null, { success: true });
    },

    Delete: (call: any, callback: any) => {
        if (isCrashed) return callback({ code: grpc.status.UNAVAILABLE, message: 'Node is down' });
        
        store.delete(call.request.key);
        callback(null, { success: true });
    },

    Heartbeat: (call: any, callback: any) => {
        // We answer the heartbeat regardless, but relay the 'alive' status
        callback(null, {
            alive: !isCrashed,
            hits: metrics.hits,
            misses: metrics.misses,
            keys: store.size
        });
    },

    SyncData: (call: any, callback: any) => {
        if (isCrashed) return callback({ code: grpc.status.UNAVAILABLE, message: 'Node is down' });

        const keysDump: Array<{ key: string; value: string; expiresAt: number }> = [];
        const now = Date.now();

        for (const [key, item] of store.entries()) {
            if (item.expiresAt === null || now < item.expiresAt) {
                keysDump.push({
                    key,
                    value: JSON.stringify(item.value),
                    expiresAt: item.expiresAt === null ? 0 : item.expiresAt
                });
            } else {
                store.delete(key);
            }
        }
        callback(null, { items: keysDump });
    }
});

// ---------------------------------------------------------
// STARTUP & BACKGROUND TASKS
// ---------------------------------------------------------
setInterval(() => {
    if (isCrashed) return;
    const now = Date.now();
    for (const [key, item] of store.entries()) {
        if (item.expiresAt !== null && now > item.expiresAt) {
            store.delete(key);
        }
    }
}, 10000);

grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), () => {
    console.log(`[${NODE_ID}] gRPC Server running on port ${GRPC_PORT}`);
    grpcServer.start();

    app.listen(REST_PORT, () => {
        console.log(`[${NODE_ID}] REST Admin running on port ${REST_PORT}`);
        
        // One-time registration with Coordinator
        axios.post(`${COORDINATOR_URL}/api/register`, {
            id: NODE_ID,
            url: NODE_URL,       // Admin REST URL
            grpcUrl: GRPC_URL    // High-speed gRPC URL
        }).catch(err => console.error(`[${NODE_ID}] Failed to register with coordinator.`));
    });
});