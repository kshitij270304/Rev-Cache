import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const NODE_ID = process.env.NODE_ID || `node-${Math.floor(Math.random() * 1000)}`;
const PORT = process.env.PORT || 3001;
const NODE_URL = process.env.NODE_URL || `http://localhost:${PORT}`;
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://localhost:3000';

// ---------------------------------------------------------
// IN-MEMORY STORAGE & STATE
// ---------------------------------------------------------
interface CacheItem {
    value: any;
    expiresAt: number | null;
}
const store = new Map<string, CacheItem>();

let metrics = {
    hits: 0,
    misses: 0
};

// Flag to simulate a node crash without killing the actual Docker container
let isCrashed = false;

// --- Crash Simulation Endpoints ---
app.post('/internal/crash', (req, res) => {
    isCrashed = true;
    console.log(`[${NODE_ID}] Simulated CRASH activated. Ignoring requests.`);
    res.send({ status: 'crashed' });
});

app.post('/internal/revive', (req, res) => {
    isCrashed = false;
    console.log(`[${NODE_ID}] Simulated REVIVAL activated. Resuming operations.`);
    res.send({ status: 'revived' });
});

// ---------------------------------------------------------
// INTERNAL CACHE API (Called by Coordinator)
// ---------------------------------------------------------
app.get('/internal/cache/:key', (req, res) => {
    if (isCrashed) return res.status(503).send({ error: 'Node is down' });

    const key = req.params.key;
    const item = store.get(key);

    if (!item) {
        metrics.misses++;
        return res.status(404).send({ error: 'Not found' });
    }

    // Check TTL (Time To Live)
    if (item.expiresAt !== null && Date.now() > item.expiresAt) {
        store.delete(key);
        metrics.misses++;
        return res.status(404).send({ error: 'Expired' });
    }

    metrics.hits++;
    res.send({ value: item.value });
});

app.post('/internal/cache/:key', (req, res) => {
    if (isCrashed) return res.status(503).send({ error: 'Node is down' });

    const key = req.params.key;
    const { value, ttl } = req.body;

    const expiresAt = ttl ? Date.now() + parseInt(ttl) : null;
    
    store.set(key, { value, expiresAt });
    console.log(`[${NODE_ID}] Saved key: ${key}`);
    
    res.send({ status: 'ok' });
});

app.delete('/internal/cache/:key', (req, res) => {
    if (isCrashed) return res.status(503).send({ error: 'Node is down' });

    const key = req.params.key;
    store.delete(key);
    res.send({ status: 'deleted' });
});

// ---------------------------------------------------------
// BACKGROUND TASKS (TTL Cleanup & Heartbeats)
// ---------------------------------------------------------

// TTL Cleanup Task: Runs every 10 seconds to delete expired keys from memory
setInterval(() => {
    const now = Date.now();
    for (const [key, item] of store.entries()) {
        if (item.expiresAt !== null && now > item.expiresAt) {
            store.delete(key);
        }
    }
}, 10000);

// Heartbeat Task: Sends health and metrics to Coordinator every 3 seconds
setInterval(async () => {
    if (isCrashed) return; // Stop sending heartbeats if crashed!

    try {
        await axios.post(`${COORDINATOR_URL}/api/heartbeat`, {
            id: NODE_ID,
            url: NODE_URL,
            metrics: {
                hits: metrics.hits,
                misses: metrics.misses,
                keys: store.size
            }
        });
    } catch (error) {
        console.error(`[${NODE_ID}] Failed to send heartbeat to Coordinator. Retrying...`);
    }
}, 3000);

// Start Node
app.listen(PORT, () => {
    console.log(`Node ${NODE_ID} starting on port ${PORT}`);
});