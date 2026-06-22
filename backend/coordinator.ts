import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(cors());

// --- Types & Interfaces ---
interface NodeInfo {
    id: string;
    url: string;
    lastHeartbeat: number;
    status: 'Healthy' | 'Dead';
    metrics: { hits: number; misses: number; keys: number };
}

// --- State Variables ---
const nodes = new Map<string, NodeInfo>();
const HEARTBEAT_TIMEOUT_MS = 6000; // If no heartbeat in 6 seconds, consider node dead
let clusterLogs: string[] = ["Coordinator started."];

function addLog(msg: string) {
    const timestamp = new Date().toLocaleTimeString();
    clusterLogs.unshift(`[${timestamp}] ${msg}`);
    if (clusterLogs.length > 50) clusterLogs.pop(); // Keep only last 50
}

// ---------------------------------------------------------
// CONSISTENT HASHING IMPLEMENTATION
// ---------------------------------------------------------
function getHash(key: string): number {
    const hashHex = crypto.createHash('md5').update(key).digest('hex');
    return parseInt(hashHex.substring(0, 8), 16); 
}

class ConsistentHashRing {
    private ring: { hash: number; nodeId: string }[] = [];

    addNode(nodeId: string) {
        const hash = getHash(nodeId);
        this.ring.push({ hash, nodeId });
        this.ring.sort((a, b) => a.hash - b.hash); 
    }

    removeNode(nodeId: string) {
        this.ring = this.ring.filter(n => n.nodeId !== nodeId);
    }

    getTargetNodes(key: string): [string | null, string | null] {
        if (this.ring.length === 0) return [null, null];
        if (this.ring.length === 1) return [this.ring[0]!.nodeId, null];

        const keyHash = getHash(key);
        
        let primaryIdx = this.ring.findIndex(n => n.hash >= keyHash);
        if (primaryIdx === -1) primaryIdx = 0;

        const replicaIdx = (primaryIdx + 1) % this.ring.length;

        return [this.ring[primaryIdx]!.nodeId, this.ring[replicaIdx]!.nodeId];
    }

    getRingState() {
        return this.ring;
    }
}

const hashRing = new ConsistentHashRing();

// ---------------------------------------------------------
// FAILURE DETECTION (SELF-HEALING)
// ---------------------------------------------------------
setInterval(() => {
    const now = Date.now();
    for (const [nodeId, node] of nodes.entries()) {
        if (node.status === 'Healthy' && (now - node.lastHeartbeat > HEARTBEAT_TIMEOUT_MS)) {
            node.status = 'Dead';
            hashRing.removeNode(nodeId);
            addLog(`❌ Node ${nodeId} marked as DEAD. Removed from Hash Ring.`);
            addLog(`🔄 Self-Healing triggered. Traffic shifted to replicas.`);
        }
    }
}, 2000);

// ---------------------------------------------------------
// HEARTBEAT ENDPOINT
// ---------------------------------------------------------
app.post('/api/heartbeat', (req, res) => {
    const { id, url, metrics } = req.body;
    
    if (!nodes.has(id) || nodes.get(id)?.status === 'Dead') {
        hashRing.addNode(id);
        addLog(`✅ Node ${id} joined the cluster. Added to Hash Ring.`);
    }

    nodes.set(id, {
        id,
        url,
        lastHeartbeat: Date.now(),
        status: 'Healthy',
        metrics
    });

    res.send({ status: 'ok' });
});

// ---------------------------------------------------------
// CLIENT FACING CACHE API (ROUTER)
// ---------------------------------------------------------
app.get('/cache/:key', async (req, res) => {
    const key = req.params.key;
    const [primaryId, replicaId] = hashRing.getTargetNodes(key);

    if (!primaryId) return res.status(503).send({ error: "No cache nodes available" });

    const primaryNode = nodes.get(primaryId);
    if (!primaryNode) return res.status(503).send({ error: "Primary node data missing" });
    
    try {
        const response = await axios.get(`${primaryNode.url}/internal/cache/${key}`, { timeout: 1000 });
        return res.send(response.data);
    } catch (error: any) {
        if (error.response?.status === 404) {
            return res.status(404).send({ error: "Key not found" });
        }
        
        // SELF HEALING READ: Fallback to replica
        if (replicaId) {
            const replicaNode = nodes.get(replicaId);
            if (!replicaNode) return res.status(500).send({ error: "Replica node data missing" });

            addLog(`⚠️ Read failed on Primary (${primaryId}). Falling back to Replica (${replicaId}).`);
            try {
                const replicaRes = await axios.get(`${replicaNode.url}/internal/cache/${key}`, { timeout: 1000 });
                return res.send(replicaRes.data);
            } catch (replicaErr: any) {
                if (replicaErr.response?.status === 404) return res.status(404).send({ error: "Key not found" });
                return res.status(500).send({ error: "Both Primary and Replica failed" });
            }
        }
        res.status(500).send({ error: "Node communication failed" });
    }
});

app.post('/cache/:key', async (req, res) => {
    const key = req.params.key;
    const payload = req.body; 
    
    const [primaryId, replicaId] = hashRing.getTargetNodes(key);
    if (!primaryId) return res.status(503).send({ error: "No cache nodes available" });

    const primaryNode = nodes.get(primaryId);
    if (!primaryNode) return res.status(503).send({ error: "Primary node data missing" });

    let success = false;

    // Write to Primary
    try {
        await axios.post(`${primaryNode.url}/internal/cache/${key}`, payload, { timeout: 1000 });
        success = true;
    } catch (e) {
        addLog(`❌ Failed to write to Primary ${primaryId}`);
    }

    // Write to Replica
    if (replicaId) {
        const replicaNode = nodes.get(replicaId);
        if (replicaNode) {
            try {
                await axios.post(`${replicaNode.url}/internal/cache/${key}`, payload, { timeout: 1000 });
                success = true; 
            } catch (e) {
                addLog(`❌ Failed to replicate to ${replicaId}`);
            }
        }
    }

    if (success) {
        res.send({ status: 'saved', primary: primaryId, replica: replicaId });
    } else {
        res.status(500).send({ error: "Failed to write to cluster" });
    }
});

// ---------------------------------------------------------
// DASHBOARD & ADMIN ENDPOINTS
// ---------------------------------------------------------
app.get('/api/dashboard', (req, res) => {
    res.json({
        nodes: Array.from(nodes.values()),
        ring: hashRing.getRingState(),
        logs: clusterLogs
    });
});

app.post('/api/nodes/:id/toggle', async (req, res) => {
    const nodeId = req.params.id;
    const node = nodes.get(nodeId);
    
    if (!node) return res.status(404).send({ error: "Node not found" });

    try {
        if (node.status === 'Healthy') {
            await axios.post(`${node.url}/internal/crash`);
            addLog(`⚡ Manual kill signal sent to ${nodeId}. Waiting for missed heartbeats...`);
        } else {
            await axios.post(`${node.url}/internal/revive`);
            addLog(`⚡ Manual revive signal sent to ${nodeId}. Node should reconnect soon.`);
        }
        res.send({ status: 'ok' });
    } catch (e) {
        res.status(500).send({ error: "Failed to communicate with node" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Coordinator running on port ${PORT}`);
});