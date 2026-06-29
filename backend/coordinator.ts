import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import cors from 'cors';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

// --- gRPC CLIENT SETUP ---
const PROTO_PATH = path.resolve(__dirname, '../proto/cache.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
});
const cacheProto = grpc.loadPackageDefinition(packageDefinition).cache as any;

// Wrapper class for Promisifying gRPC callbacks
class GrpcWrapper {
    public client: any;

    constructor(grpcUrl: string) {
        this.client = new cacheProto.CacheService(grpcUrl, grpc.credentials.createInsecure());
    }

    private withTimeout(timeoutMs = 1000) {
        return { deadline: new Date(Date.now() + timeoutMs) };
    }

    Get(key: string): Promise<any> {
        return new Promise((resolve, reject) => {
            this.client.Get({ key }, this.withTimeout(), (err: any, res: any) => {
                if (err) reject(err); else resolve(res);
            });
        });
    }

    Put(key: string, value: any, ttl?: number): Promise<any> {
        return new Promise((resolve, reject) => {
            const payload = { key, value: JSON.stringify(value), ttl: ttl || 0 };
            this.client.Put(payload, this.withTimeout(), (err: any, res: any) => {
                if (err) reject(err); else resolve(res);
            });
        });
    }

    Delete(key: string): Promise<any> {
        return new Promise((resolve, reject) => {
            this.client.Delete({ key }, this.withTimeout(), (err: any, res: any) => {
                if (err) reject(err); else resolve(res);
            });
        });
    }

    Heartbeat(): Promise<any> {
        return new Promise((resolve, reject) => {
            this.client.Heartbeat({}, this.withTimeout(1500), (err: any, res: any) => {
                if (err) reject(err); else resolve(res);
            });
        });
    }

    SyncData(): Promise<any> {
        return new Promise((resolve, reject) => {
            this.client.SyncData({}, this.withTimeout(3000), (err: any, res: any) => {
                if (err) reject(err); else resolve(res);
            });
        });
    }
}

// --- EXPRESS SETUP ---
const app = express();
app.use(express.json());
app.use(cors());

// --- STATE & TYPES ---
interface NodeInfo {
    id: string;
    url: string;      // Admin REST
    grpcUrl: string;  // gRPC Address
    grpc: GrpcWrapper;
    lastHeartbeat: number;
    status: 'Healthy' | 'Dead';
    metrics: { hits: number; misses: number; keys: number };
}

const nodes = new Map<string, NodeInfo>();
const HEARTBEAT_TIMEOUT_MS = 6000;
let clusterLogs: string[] = ["Coordinator started."];

function addLog(msg: string) {
    const timestamp = new Date().toLocaleTimeString();
    clusterLogs.unshift(`[${timestamp}] ${msg}`);
    if (clusterLogs.length > 50) clusterLogs.pop();
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
        if (!this.ring.some(n => n.nodeId === nodeId)) {
            this.ring.push({ hash: getHash(nodeId), nodeId });
            this.ring.sort((a, b) => a.hash - b.hash); 
        }
    }

    removeNode(nodeId: string) {
        this.ring = this.ring.filter(n => n.nodeId !== nodeId);
    }

    getRingState() { return this.ring; }
}

const hashRing = new ConsistentHashRing();

function getNodesForKey(key: string): [NodeInfo | null, NodeInfo | null] {
    const ringState = hashRing.getRingState();
    if (ringState.length === 0) return [null, null];

    const healthyRing = ringState.filter(item => nodes.get(item.nodeId)?.status === 'Healthy');
    if (healthyRing.length === 0) return [null, null];

    let primaryIdx = healthyRing.findIndex(n => n.hash >= getHash(key));
    if (primaryIdx === -1) primaryIdx = 0;
    
    const primaryNode = nodes.get(healthyRing[primaryIdx].nodeId) || null;
    let replicaNode = null;
    
    if (healthyRing.length > 1) {
        const replicaIdx = (primaryIdx + 1) % healthyRing.length;
        replicaNode = nodes.get(healthyRing[replicaIdx].nodeId) || null;
    }
    return [primaryNode, replicaNode];
}

// ---------------------------------------------------------
// SELF-HEALING RECOVERY SYNCHRONIZATION (Via gRPC)
// ---------------------------------------------------------
async function syncRecoveredNode(nodeId: string) {
    const recoveredNode = nodes.get(nodeId);
    if (!recoveredNode || recoveredNode.status !== 'Healthy') return;

    addLog(`🔄 Node Recovery process initiated for ${nodeId} via gRPC...`);
    const allKeysToSync = new Map<string, { value: any; ttl?: number }>();

    for (const [otherId, otherNode] of nodes.entries()) {
        if (otherId === nodeId || otherNode.status !== 'Healthy') continue;

        try {
            const response = await otherNode.grpc.SyncData();
            for (const item of (response.items || [])) {
                const { key, value, expiresAt } = item;
                
                let ttl: number | undefined = undefined;
                if (expiresAt > 0) {
                    const remaining = expiresAt - Date.now();
                    if (remaining <= 0) continue; 
                    ttl = remaining;
                }

                const [primary, replica] = getNodesForKey(key);
                if ((primary && primary.id === nodeId) || (replica && replica.id === nodeId)) {
                    allKeysToSync.set(key, { value: JSON.parse(value), ttl });
                }
            }
        } catch (err) {
            addLog(`⚠️ gRPC SyncData failed for source ${otherId}`);
        }
    }

    let syncCount = 0;
    for (const [key, payload] of allKeysToSync.entries()) {
        try {
            await recoveredNode.grpc.Put(key, payload.value, payload.ttl);
            syncCount++;
        } catch (err) {
            addLog(`❌ Failed to sync key "${key}" to recovered node ${nodeId}`);
        }
    }
    addLog(`✅ Rebuilding complete for ${nodeId}. Recovered ${syncCount} keys via gRPC.`);
}

// ---------------------------------------------------------
// PULL-BASED HEARTBEAT & FAILURE DETECTION
// ---------------------------------------------------------
setInterval(async () => {
    const now = Date.now();
    for (const [id, node] of nodes.entries()) {
        try {
            const res = await node.grpc.Heartbeat();
            if (res.alive) {
                const wasDead = node.status === 'Dead';
                node.status = 'Healthy';
                node.lastHeartbeat = Date.now();
                node.metrics = { hits: res.hits, misses: res.misses, keys: res.keys };
                
                if (wasDead) {
                    hashRing.addNode(id);
                    addLog(`✅ Node ${id} recovered via gRPC Heartbeat. Added to Hash Ring.`);
                    syncRecoveredNode(id).catch(console.error);
                }
            }
        } catch (e) {
            // gRPC Call failed, let the timeout catch it
        }

        if (node.status === 'Healthy' && (now - node.lastHeartbeat > HEARTBEAT_TIMEOUT_MS)) {
            node.status = 'Dead';
            hashRing.removeNode(id);
            addLog(`❌ Node ${id} gRPC Timeout. Marked DEAD and removed from Hash Ring.`);
            addLog(`🔄 Self-Healing triggered.`);
        }
    }
}, 2000);

// ---------------------------------------------------------
// DISCOVERY REGISTRATION ENDPOINT
// ---------------------------------------------------------
app.post('/api/register', (req, res) => {
    const { id, url, grpcUrl } = req.body;
    
    if (!nodes.has(id)) {
        hashRing.addNode(id);
        addLog(`✅ Node ${id} registered to cluster via REST. Initiating gRPC link.`);
        
        nodes.set(id, {
            id, url, grpcUrl,
            grpc: new GrpcWrapper(grpcUrl),
            lastHeartbeat: Date.now(),
            status: 'Healthy',
            metrics: { hits: 0, misses: 0, keys: 0 }
        });
    }
    res.send({ status: 'ok' });
});

// ---------------------------------------------------------
// CLIENT FACING CACHE API (RF = 2 ROUTER over gRPC)
// ---------------------------------------------------------
app.get('/cache/:key', async (req, res) => {
    const key = req.params.key;
    const [primaryNode, replicaNode] = getNodesForKey(key);

    if (!primaryNode) return res.status(503).send({ error: "No cache nodes available" });

    try {
        const result = await primaryNode.grpc.Get(key);
        if (!result.found) return res.status(404).send({ error: "Key not found" });
        return res.send({ value: JSON.parse(result.value) });
    } catch (error: any) {
        // SELF HEALING READ FALLBACK
        if (replicaNode) {
            addLog(`⚠️ Read failed on Primary (${primaryNode.id}). gRPC Failover to Replica (${replicaNode.id}).`);
            try {
                const replicaRes = await replicaNode.grpc.Get(key);
                if (!replicaRes.found) return res.status(404).send({ error: "Key not found" });
                return res.send({ value: JSON.parse(replicaRes.value) });
            } catch (replicaErr: any) {
                return res.status(500).send({ error: "Both Primary and Replica failed via gRPC" });
            }
        }
        res.status(500).send({ error: "Primary failed and no replica available" });
    }
});

app.post('/cache/:key', async (req, res) => {
    const key = req.params.key;
    const payload = req.body; 
    
    const [primaryNode, replicaNode] = getNodesForKey(key);
    if (!primaryNode) return res.status(503).send({ error: "No cache nodes available" });

    let primarySuccess = false;
    let replicaSuccess = false;

    try {
        await primaryNode.grpc.Put(key, payload.value, payload.ttl);
        primarySuccess = true;
    } catch (e) {
        addLog(`❌ gRPC write failed on Primary ${primaryNode.id}`);
    }

    if (replicaNode) {
        try {
            await replicaNode.grpc.Put(key, payload.value, payload.ttl);
            replicaSuccess = true; 
        } catch (e) {
            addLog(`❌ gRPC replication failed to ${replicaNode.id}`);
        }
    } else {
        replicaSuccess = true;
    }

    if (primarySuccess && replicaSuccess) {
        res.send({ status: 'saved', primary: primaryNode.id, replica: replicaNode ? replicaNode.id : null });
    } else {
        res.status(500).send({ error: "Failed to write successfully to replicated cluster nodes" });
    }
});

app.delete('/cache/:key', async (req, res) => {
    const key = req.params.key;
    const [primaryNode, replicaNode] = getNodesForKey(key);

    if (!primaryNode) return res.status(503).send({ error: "No cache nodes available" });

    let primarySuccess = false;
    let replicaSuccess = false;

    try {
        await primaryNode.grpc.Delete(key);
        primarySuccess = true;
    } catch (e) { addLog(`❌ gRPC delete failed on Primary ${primaryNode.id}`); }

    if (replicaNode) {
        try {
            await replicaNode.grpc.Delete(key);
            replicaSuccess = true;
        } catch (e) { addLog(`❌ gRPC delete failed on Replica ${replicaNode.id}`); }
    } else {
        replicaSuccess = true;
    }

    if (primarySuccess && replicaSuccess) {
        res.send({ status: 'deleted', primary: primaryNode.id, replica: replicaNode ? replicaNode.id : null });
    } else {
        res.status(500).send({ error: "Failed to delete key cleanly from all target nodes" });
    }
});

// ---------------------------------------------------------
// DASHBOARD & ADMIN
// ---------------------------------------------------------
app.get('/api/dashboard', (req, res) => {
    const sanitizedNodes = Array.from(nodes.values()).map(n => {
        const { grpc, ...rest } = n; // omit grpc client object from dashboard response
        return rest;
    });
    res.json({ nodes: sanitizedNodes, ring: hashRing.getRingState(), logs: clusterLogs });
});

app.post('/api/nodes/:id/toggle', async (req, res) => {
    const nodeId = req.params.id;
    const node = nodes.get(nodeId);
    if (!node) return res.status(404).send({ error: "Node not found" });

    try {
        const action = node.status === 'Healthy' ? 'crash' : 'revive';
        await axios.post(`${node.url}/internal/${action}`); // Simulation triggers remain REST
        addLog(`⚡ Manual ${action} signal sent to ${nodeId} via REST backdoor.`);
        res.send({ status: 'ok' });
    } catch (e) {
        res.status(500).send({ error: "Failed to communicate with simulated node process" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Coordinator running on port ${PORT}. Client REST API active.`);
});