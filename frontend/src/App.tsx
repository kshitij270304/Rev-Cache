import { useEffect, useState, useRef } from 'react';
import { 
  Server, 
  Database, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Zap, 
  Plus, 
  Search, 
  Play, 
  Pause, 
  RotateCcw
} from 'lucide-react';

// --- Types ---
interface NodeData {
    id: string;
    url: string;
    lastHeartbeat: number;
    status: 'Healthy' | 'Dead';
    metrics: { hits: number; misses: number; keys: number };
    data: Map<string, { value: any; expiresAt: number | null }>; 
}

interface DashboardState {
    nodes: NodeData[];
    ring: { hash: number; nodeId: string; angle: number }[];
    logs: string[];
}

export default function App() {
    // State management
    const [state, setState] = useState<DashboardState>({ nodes: [], ring: [], logs: [] });
    const [isConnected, setIsConnected] = useState(false);
    
    // Interactive Form State
    const [inputKey, setInputKey] = useState('');
    const [inputValue, setInputValue] = useState('');
    const [inputTtl, setInputTtl] = useState('60000');
    const [searchKey, setSearchKey] = useState('');
    const [searchResult, setSearchResult] = useState<{ found: boolean; value?: any; source?: string; error?: string } | null>(null);
    const [autoTraffic, setAutoTraffic] = useState(false);
    
    // Animation/Visual State
    const [ringAnimation, setRingAnimation] = useState<{ keyHash: number; keyAngle: number; primaryId: string; replicaId: string } | null>(null);
    const tailwindInjected = useRef(false);

    // --- 1. DYNAMIC TAILWIND & STYLE INJECTION ---
    useEffect(() => {
        if (!tailwindInjected.current) {
            const script = document.createElement('script');
            script.src = 'https://cdn.tailwindcss.com';
            document.head.appendChild(script);

            const style = document.createElement('style');
            style.innerHTML = `
                /* FORCE OVERRIDE VITE DEFAULT BOILERPLATE STYLES */
                html, body {
                    margin: 0 !important;
                    padding: 0 !important;
                    width: 100% !important;
                    height: 100% !important;
                    min-height: 100vh !important;
                    display: block !important;
                    place-items: unset !important;
                    background-color: #090a0f !important; /* graphite */
                }
                #root {
                    max-width: 100% !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    text-align: left !important;
                    width: 100% !important;
                    min-height: 100vh !important;
                    display: flex !important;
                    flex-direction: column !important;
                }
                @keyframes pulse-ring {
                    0% { transform: scale(0.95); opacity: 0.8; }
                    50% { transform: scale(1.05); opacity: 0.4; }
                    100% { transform: scale(0.95); opacity: 0.8; }
                }
                .pulse-effect {
                    animation: pulse-ring 2s infinite ease-in-out;
                }
                ::-webkit-scrollbar { width: 6px; }
                ::-webkit-scrollbar-track { background: #18181b; }
                ::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 3px; }
            `;
            document.head.appendChild(style);
            tailwindInjected.current = true;
        }
    }, []);

    // --- 2. LOCAL SIMULATION ENGINE ---
    const simulationState = useRef<{
        nodes: Map<string, NodeData>;
        logs: string[];
    }>(new Map() as any);

    const addSimLog = (msg: string) => {
        const timestamp = new Date().toLocaleTimeString();
        const formattedLog = `[${timestamp}] ${msg}`;
        setState(prev => ({
            ...prev,
            logs: [formattedLog, ...prev.logs.slice(0, 49)]
        }));
    };

    const getSimHashAngle = (str: string): number => {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        return Math.abs(hash) % 360;
    };

    const initializeSimulation = () => {
        const initNodes = new Map<string, NodeData>();
        const nodeIds = ['node-1', 'node-2', 'node-3'];
        
        nodeIds.forEach((id, index) => {
            initNodes.set(id, {
                id,
                url: `http://localhost:300${index + 1}`,
                lastHeartbeat: Date.now(),
                status: 'Healthy',
                metrics: { hits: 142 + index * 12, misses: 12 - index, keys: 2 },
                data: new Map([
                    ['welcome-msg', { value: `Hello from ${id}!`, expiresAt: null }],
                    ['cluster-info', { value: 'In-memory dynamic simulation active.', expiresAt: null }]
                ])
            });
        });

        simulationState.current.nodes = initNodes;
        
        const ringTopology = nodeIds.map(id => ({
            nodeId: id,
            hash: getSimHashAngle(id) * 1000, 
            angle: getSimHashAngle(id)
        })).sort((a, b) => a.angle - b.angle);

        setState({
            nodes: Array.from(initNodes.values()),
            ring: ringTopology,
            logs: [
                `[${new Date().toLocaleTimeString()}] 🚀 Local Cluster Simulation initialized!`,
                `[${new Date().toLocaleTimeString()}] ✅ Consistent Hash Ring created with 3 active physical nodes.`
            ]
        });
    };

    const handleSimulateSet = async (key: string, val: string, ttlMs: number) => {
        if (!key || !val) return;
        
        if (isConnected) {
            try {
                await fetch(`http://localhost:3000/cache/${key}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ value: val, ttl: ttlMs })
                });
                setInputKey('');
                setInputValue('');
            } catch (err) {
                console.error("Live write failed", err);
            }
            return;
        }

        const keyAngle = getSimHashAngle(key);
        const activeRing = state.ring.filter(r => {
            const node = simulationState.current.nodes?.get(r.nodeId);
            return node && node.status === 'Healthy';
        });

        if (activeRing.length === 0) {
            addSimLog(`❌ WRITE FAILED: No healthy cache nodes available on the ring.`);
            return;
        }

        let primaryIdx = activeRing.findIndex(r => r.angle >= keyAngle);
        if (primaryIdx === -1) primaryIdx = 0;
        const primaryId = activeRing[primaryIdx].nodeId;

        let replicaId = '';
        if (activeRing.length > 1) {
            const replicaIdx = (primaryIdx + 1) % activeRing.length;
            replicaId = activeRing[replicaIdx].nodeId;
        }

        setRingAnimation({ keyHash: keyAngle * 1000, keyAngle, primaryId, replicaId });

        const expiresAt = ttlMs ? Date.now() + ttlMs : null;
        const primaryNode = simulationState.current.nodes.get(primaryId);
        if (primaryNode) {
            primaryNode.data.set(key, { value: val, expiresAt });
            primaryNode.metrics.keys = primaryNode.data.size;
        }

        if (replicaId) {
            const replicaNode = simulationState.current.nodes.get(replicaId);
            if (replicaNode) {
                replicaNode.data.set(key, { value: val, expiresAt });
                replicaNode.metrics.keys = replicaNode.data.size;
                addSimLog(`✍️ Write: "${key}" -> Routed to Primary [${primaryId}] & Replicated to [${replicaId}]`);
            }
        } else {
            addSimLog(`✍️ Write: "${key}" -> Routed to Primary [${primaryId}] (No replica node available)`);
        }

        setState(prev => ({ ...prev, nodes: Array.from(simulationState.current.nodes.values()) }));
        setInputKey('');
        setInputValue('');
    };

    const handleSimulateGet = async (key: string) => {
        if (!key) return;

        if (isConnected) {
            try {
                const res = await fetch(`http://localhost:3000/cache/${key}`);
                if (res.ok) {
                    const data = await res.json();
                    setSearchResult({ found: true, value: data.value, source: `Live Cluster` });
                } else {
                    setSearchResult({ found: false, error: 'Key not found in Live Cluster.' });
                }
            } catch (err) {
                setSearchResult({ found: false, error: 'Failed to communicate with Live Cluster.' });
            }
            return;
        }

        const keyAngle = getSimHashAngle(key);
        const activeRing = state.ring.filter(r => {
            const node = simulationState.current.nodes?.get(r.nodeId);
            return node && node.status === 'Healthy';
        });

        if (activeRing.length === 0) {
            setSearchResult({ found: false, error: 'No active nodes in cluster' });
            addSimLog(`❌ READ FAILED: Cluster is completely offline.`);
            return;
        }

        let primaryIdx = activeRing.findIndex(r => r.angle >= keyAngle);
        if (primaryIdx === -1) primaryIdx = 0;
        const primaryId = activeRing[primaryIdx].nodeId;

        let replicaId = '';
        if (activeRing.length > 1) {
            const replicaIdx = (primaryIdx + 1) % activeRing.length;
            replicaId = activeRing[replicaIdx].nodeId;
        }

        setRingAnimation({ keyHash: keyAngle * 1000, keyAngle, primaryId, replicaId });

        const primaryNode = simulationState.current.nodes.get(primaryId);
        const item = primaryNode?.data.get(key);

        if (item && (item.expiresAt === null || Date.now() < item.expiresAt)) {
            if (primaryNode) primaryNode.metrics.hits++;
            setSearchResult({ found: true, value: item.value, source: `${primaryId} (Primary)` });
            addSimLog(`🔍 Cache Hit: Found "${key}" on Primary [${primaryId}]`);
        } else {
            if (primaryNode) primaryNode.metrics.misses++;
            
            if (replicaId) {
                const replicaNode = simulationState.current.nodes.get(replicaId);
                const replicaItem = replicaNode?.data.get(key);

                if (replicaItem && (replicaItem.expiresAt === null || Date.now() < replicaItem.expiresAt)) {
                    if (replicaNode) replicaNode.metrics.hits++;
                    setSearchResult({ found: true, value: replicaItem.value, source: `${replicaId} (Replica Fallback)` });
                    addSimLog(`⚠️ Failover Read: Primary [${primaryId}] missed. Successfully fetched "${key}" from Replica [${replicaId}]`);
                } else {
                    if (replicaNode) replicaNode.metrics.misses++;
                    setSearchResult({ found: false, error: 'Key not found anywhere in cluster.' });
                    addSimLog(`🔍 Cache Miss: Key "${key}" not found on Primary or Replica.`);
                }
            } else {
                setSearchResult({ found: false, error: 'Key not found.' });
                addSimLog(`🔍 Cache Miss: Key "${key}" not found on Primary [${primaryId}]`);
            }
        }

        setState(prev => ({ ...prev, nodes: Array.from(simulationState.current.nodes.values()) }));
    };

    const toggleNodeStatusSim = async (nodeId: string) => {
        if (isConnected) {
            try {
                await fetch(`http://localhost:3000/api/nodes/${nodeId}/toggle`, { method: 'POST' });
            } catch (err) {
                console.error("Failed to toggle live node", err);
            }
            return; 
        }

        const node = simulationState.current.nodes.get(nodeId);
        if (!node) return;

        if (node.status === 'Healthy') {
            node.status = 'Dead';
            setState(prev => ({
                ...prev,
                ring: prev.ring.filter(r => r.nodeId !== nodeId),
                nodes: Array.from(simulationState.current.nodes.values())
            }));
            addSimLog(`❌ Node [${nodeId}] simulated CRASH! Heartbeats stopped.`);
            addSimLog(`🔄 Consistent Hashing self-healed: Ring restructured seamlessly.`);
        } else {
            node.status = 'Healthy';
            node.lastHeartbeat = Date.now();
            
            const originalAngle = getSimHashAngle(nodeId);
            setState(prev => {
                const newRing = [...prev.ring, { nodeId, hash: originalAngle * 1000, angle: originalAngle }];
                newRing.sort((a, b) => a.angle - b.angle);
                return {
                    ...prev,
                    ring: newRing,
                    nodes: Array.from(simulationState.current.nodes.values())
                };
            });
            addSimLog(`✅ Node [${nodeId}] recovered! Heartbeats restored.`);
        }
    };

    // --- 3. FETCH AND SYNC CONTROLLER ---
    useEffect(() => {
        initializeSimulation();

        const fetchState = async () => {
            try {
                const res = await fetch('http://localhost:3000/api/dashboard');
                if (res.ok) {
                    const data = await res.json();
                    const updatedRing = data.ring.map((rn: any) => ({
                        ...rn,
                        angle: getSimHashAngle(rn.nodeId)
                    }));
                    setState({
                        nodes: data.nodes,
                        ring: updatedRing,
                        logs: data.logs
                    });
                    setIsConnected(true);
                } else {
                    throw new Error("Local coordinator offline");
                }
            } catch (err) {
                setIsConnected(false); 
            }
        };

        const interval = setInterval(fetchState, 3000);
        return () => clearInterval(interval);
    }, []);

    // Simulated Traffic Loop
    useEffect(() => {
        if (!autoTraffic) return;

        const interval = setInterval(() => {
            const demoKeys = ['user-profile', 'auth-token', 'product-list', 'pricing-tier', 'session-meta', 'cart-payload'];
            const randomKey = demoKeys[Math.floor(Math.random() * demoKeys.length)];
            
            if (Math.random() > 0.4) {
                handleSimulateSet(randomKey, `val-${Math.floor(Math.random() * 1000)}`, 60000);
            } else {
                handleSimulateGet(randomKey);
            }
        }, 3000);

        return () => clearInterval(interval);
    }, [autoTraffic, state.ring, isConnected]);

    const activeNodes = state.nodes.filter(n => n.status === 'Healthy');
    const deadNodesCount = state.nodes.length - activeNodes.length;
    const totalKeys = activeNodes.reduce((acc, curr) => acc + (curr.metrics?.keys || 0), 0);
    const totalHits = state.nodes.reduce((acc, curr) => acc + (curr.metrics?.hits || 0), 0);
    const totalMisses = state.nodes.reduce((acc, curr) => acc + (curr.metrics?.misses || 0), 0);

    return (
        <div className="min-h-screen bg-[#090a0f] text-slate-200 flex flex-col font-sans selection:bg-blue-500/30">
            {/* Minimalist Professional Header Bar */}
            <header className="border-b border-zinc-800 bg-[#090a0f]/80 backdrop-blur-md sticky top-0 z-50 px-8 py-5 flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <h1 className="text-2xl font-extrabold tracking-tight text-white">RevCache</h1>
                    <div className="h-5 w-[1px] bg-zinc-700 mx-2"></div>
                    <p className="text-sm font-medium text-zinc-400">Self-Healing Distributed Cache System</p>
                </div>
                
                {/* Live Connection indicator dot ONLY */}
                {isConnected && (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 text-xs font-bold text-emerald-400">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        LIVE BACKEND
                    </div>
                )}
            </header>

            <main className="flex-1 max-w-[1400px] w-full mx-auto p-6 lg:p-8 space-y-8">
                {/* Graphite Style Metrics Cards Grid */}
                <section className="grid grid-cols-2 lg:grid-cols-4 gap-5">
                    <div className="bg-[#151618] border border-zinc-800 rounded-xl p-5 flex items-center justify-between shadow-lg">
                        <div>
                            <p className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Cluster Health</p>
                            <h3 className="text-3xl font-black text-white">
                                {activeNodes.length} <span className="text-zinc-600 text-xl font-bold">/ {state.nodes.length}</span>
                            </h3>
                            <p className="text-xs text-zinc-500 mt-2">Active cache nodes</p>
                        </div>
                        <div className="p-3.5 bg-blue-500/5 text-blue-400 rounded-xl border border-blue-500/10">
                            <Server className="w-6 h-6" />
                        </div>
                    </div>

                    <div className="bg-[#151618] border border-zinc-800 rounded-xl p-5 flex items-center justify-between shadow-lg">
                        <div>
                            <p className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Cached Keys</p>
                            <h3 className="text-3xl font-black text-white">{totalKeys}</h3>
                            <p className="text-xs text-zinc-500 mt-2">Distributed globally</p>
                        </div>
                        <div className="p-3.5 bg-indigo-500/5 text-indigo-400 rounded-xl border border-indigo-500/10">
                            <Database className="w-6 h-6" />
                        </div>
                    </div>

                    <div className="bg-[#151618] border border-zinc-800 rounded-xl p-5 flex items-center justify-between shadow-lg">
                        <div>
                            <p className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Hit Ratio</p>
                            <h3 className="text-3xl font-black text-emerald-400">
                                {totalHits + totalMisses > 0 
                                    ? `${((totalHits / (totalHits + totalMisses)) * 100).toFixed(1)}%` 
                                    : '100%'}
                            </h3>
                            <p className="text-xs text-emerald-500/60 mt-2">{totalHits} total hits</p>
                        </div>
                        <div className="p-3.5 bg-emerald-500/5 text-emerald-400 rounded-xl border border-emerald-500/10">
                            <Zap className="w-6 h-6" />
                        </div>
                    </div>

                    <div className="bg-[#151618] border border-zinc-800 rounded-xl p-5 flex items-center justify-between shadow-lg">
                        <div>
                            <p className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Failed Nodes</p>
                            <h3 className={`text-3xl font-black ${deadNodesCount > 0 ? 'text-rose-500 animate-pulse' : 'text-zinc-600'}`}>
                                {deadNodesCount}
                            </h3>
                            <p className="text-xs text-zinc-500 mt-2">Self-healing ready</p>
                        </div>
                        <div className={`p-3.5 rounded-xl border ${deadNodesCount > 0 ? 'bg-rose-500/5 text-rose-400 border-rose-500/10' : 'bg-[#111113] text-zinc-600 border-zinc-800'}`}>
                            <XCircle className="w-6 h-6" />
                        </div>
                    </div>
                </section>

                {/* Operations Deck */}
                <section className="bg-[#151618] border border-zinc-800 rounded-xl p-6 shadow-lg grid grid-cols-1 lg:grid-cols-12 gap-8">
                    <div className="lg:col-span-4 space-y-5">
                        <div className="flex items-center gap-3">
                            <span className="text-blue-500"><Plus size={20} /></span>
                            <h3 className="font-bold text-white tracking-wide text-sm">MANUAL WRITE</h3>
                        </div>
                        <div className="space-y-3">
                            <input 
                                type="text" 
                                placeholder="Enter Key (e.g., config-meta)" 
                                value={inputKey}
                                onChange={(e) => setInputKey(e.target.value)}
                                className="w-full bg-[#090a0f] border border-zinc-800 rounded-lg px-4 py-3 text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all placeholder-zinc-600"
                            />
                            <input 
                                type="text" 
                                placeholder="Enter Value String" 
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                                className="w-full bg-[#090a0f] border border-zinc-800 rounded-lg px-4 py-3 text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all placeholder-zinc-600"
                            />
                            <div className="flex items-center gap-3">
                                <span className="text-[11px] font-bold text-zinc-500 uppercase">TTL:</span>
                                <select 
                                    value={inputTtl}
                                    onChange={(e) => setInputTtl(e.target.value)}
                                    className="w-full bg-[#090a0f] border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-300 focus:outline-none"
                                >
                                    <option value="10000">10,000 ms (10s)</option>
                                    <option value="60000">60,000 ms (1m)</option>
                                    <option value="3600000">3,600,000 ms (1h)</option>
                                    <option value="0">Persistent (0)</option>
                                </select>
                            </div>
                            <button 
                                onClick={() => handleSimulateSet(inputKey, inputValue, parseInt(inputTtl))}
                                className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-lg text-sm transition-all shadow-[0_0_15px_rgba(37,99,235,0.2)] active:scale-[0.98]"
                            >
                                Execute Write
                            </button>
                        </div>
                    </div>

                    <div className="lg:col-span-4 space-y-5 border-t lg:border-t-0 lg:border-x border-zinc-800 lg:px-8 pt-6 lg:pt-0">
                        <div className="flex items-center gap-3">
                            <span className="text-emerald-500"><Search size={20} /></span>
                            <h3 className="font-bold text-white tracking-wide text-sm">MANUAL READ</h3>
                        </div>
                        <div className="space-y-3">
                            <div className="flex gap-2">
                                <input 
                                    type="text" 
                                    placeholder="Key to fetch..." 
                                    value={searchKey}
                                    onChange={(e) => setSearchKey(e.target.value)}
                                    className="w-full bg-[#090a0f] border border-zinc-800 rounded-lg px-4 py-3 text-sm text-white focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all placeholder-zinc-600"
                                />
                                <button 
                                    onClick={() => handleSimulateGet(searchKey)}
                                    className="bg-zinc-800 hover:bg-zinc-700 text-white font-bold px-5 rounded-lg transition-all"
                                >
                                    Fetch
                                </button>
                            </div>

                            <div className="bg-[#090a0f] border border-zinc-800 rounded-lg p-4 h-[126px] overflow-y-auto flex flex-col justify-center text-xs shadow-inner">
                                {searchResult ? (
                                    searchResult.found ? (
                                        <div className="space-y-2">
                                            <div className="flex justify-between items-center border-b border-zinc-800 pb-2">
                                                <span className="text-emerald-400 font-black tracking-wide">SUCCESS</span>
                                                <span className="text-zinc-500 font-mono text-[10px]">{searchResult.source}</span>
                                            </div>
                                            <p className="text-zinc-300 font-mono break-all leading-relaxed">
                                                {searchResult.value}
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="text-center text-rose-400 space-y-2">
                                            <XCircle className="mx-auto w-6 h-6 text-rose-500/80" />
                                            <p className="font-medium">{searchResult.error}</p>
                                        </div>
                                    )
                                ) : (
                                    <div className="text-center text-zinc-600 font-medium">
                                        No active query.
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="lg:col-span-4 space-y-5 pt-6 lg:pt-0 lg:pl-4">
                        <div className="flex items-center gap-3">
                            <span className="text-amber-500"><Zap size={20} /></span>
                            <h3 className="font-bold text-white tracking-wide text-sm">LOAD TESTER</h3>
                        </div>
                        <div className="bg-[#090a0f] border border-zinc-800 rounded-lg p-5 space-y-4 h-[182px] flex flex-col justify-between">
                            <p className="text-sm text-zinc-400 leading-relaxed">
                                Automate read/write transactions to stress test the topology. Combined with manual node kills, observe real-time self-healing capabilities.
                            </p>
                            <button 
                                onClick={() => setAutoTraffic(!autoTraffic)}
                                className={`w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-bold transition-all shadow-md ${
                                    autoTraffic 
                                        ? 'bg-rose-600/10 border border-rose-500/30 hover:bg-rose-600/20 text-rose-400' 
                                        : 'bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 text-white'
                                }`}
                            >
                                {autoTraffic ? <Pause size={16} /> : <Play size={16} />}
                                {autoTraffic ? 'Halt Auto-Traffic' : 'Commence Traffic'}
                            </button>
                        </div>
                    </div>
                </section>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                    <div className="lg:col-span-7 space-y-4">
                        {state.nodes.map(node => (
                            <div 
                                key={node.id} 
                                className={`relative p-6 rounded-xl border transition-all duration-300 shadow-md ${
                                    node.status === 'Healthy' 
                                        ? 'bg-[#151618] border-zinc-800' 
                                        : 'bg-rose-950/10 border-rose-900/20'
                                }`}
                            >
                                <div className="flex justify-between items-start gap-4">
                                    <div className="space-y-1.5">
                                        <div className="flex items-center gap-3">
                                            <h3 className="font-black text-white text-xl font-mono tracking-tight">{node.id}</h3>
                                            <span className={`text-[9px] uppercase tracking-widest font-black px-2 py-1 rounded-sm border ${
                                                node.status === 'Healthy' 
                                                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                                                    : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                                            }`}>
                                                {node.status}
                                            </span>
                                        </div>
                                        <p className="text-xs font-mono text-zinc-500">{node.url}</p>
                                    </div>

                                    <div className="flex items-center gap-4">
                                        <span className="text-[11px] font-mono text-zinc-500 flex items-center gap-1.5">
                                            <Clock size={12} /> Seen: {Math.floor((Date.now() - node.lastHeartbeat) / 1000)}s
                                        </span>
                                        <button 
                                            onClick={() => toggleNodeStatusSim(node.id)}
                                            className={`text-[11px] font-bold px-4 py-2 rounded-md border transition-all tracking-wide uppercase ${
                                                node.status === 'Healthy' 
                                                    ? 'bg-rose-600/5 border-rose-600/20 text-rose-400 hover:bg-rose-600 hover:text-white' 
                                                    : 'bg-emerald-600/5 border-emerald-600/20 text-emerald-400 hover:bg-emerald-600 hover:text-white'
                                            }`}
                                        >
                                            {node.status === 'Healthy' ? 'Kill Node' : 'Revive Node'}
                                        </button>
                                    </div>
                                </div>

                                {node.status === 'Healthy' ? (
                                    <div className="grid grid-cols-3 gap-4 mt-6">
                                        <div className="bg-[#090a0f] p-4 rounded-lg border border-zinc-800/50 text-center">
                                            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Metrics Keys</p>
                                            <p className="text-xl font-black text-white">{node.metrics?.keys || 0}</p>
                                        </div>
                                        <div className="bg-[#090a0f] p-4 rounded-lg border border-zinc-800/50 text-center">
                                            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Hits</p>
                                            <p className="text-xl font-black text-emerald-400">{node.metrics?.hits || 0}</p>
                                        </div>
                                        <div className="bg-[#090a0f] p-4 rounded-lg border border-zinc-800/50 text-center">
                                            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Misses</p>
                                            <p className="text-xl font-black text-rose-400">{node.metrics?.misses || 0}</p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="bg-[#090a0f] border border-rose-900/10 rounded-lg p-4 text-center text-xs text-rose-500/70 font-medium mt-6">
                                        Node is unreachable. Ring topology has bypassed this sector.
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    <div className="lg:col-span-5 space-y-4">
                        <div className="bg-[#151618] border border-zinc-800 rounded-xl p-8 shadow-lg flex flex-col items-center justify-center relative min-h-[500px]">
                            <svg width="280" height="280" className="relative transform rotate-[-90deg]">
                                <circle cx="140" cy="140" r="105" fill="transparent" stroke="#18181b" strokeWidth="4" className="pulse-effect" />
                                <circle cx="140" cy="140" r="105" fill="transparent" stroke="#27272a" strokeWidth="2" strokeDasharray="6 4" />
                                
                                {state.ring.map((ringNode, index) => {
                                    const rad = (ringNode.angle * Math.PI) / 180;
                                    const x = 140 + 105 * Math.cos(rad);
                                    const y = 140 + 105 * Math.sin(rad);
                                    
                                    return (
                                        <g key={`${ringNode.nodeId}-${index}`}>
                                            <circle cx={x} cy={y} r="10" fill="#090a0f" stroke="#52525b" strokeWidth="3" />
                                            <circle cx={x} cy={y} r="4" fill="#a1a1aa" />
                                        </g>
                                    );
                                })}

                                {ringAnimation && (() => {
                                    const keyRad = (ringAnimation.keyAngle * Math.PI) / 180;
                                    const kx = 140 + 105 * Math.cos(keyRad);
                                    const ky = 140 + 105 * Math.sin(keyRad);
                                    return (
                                        <g>
                                            <circle cx={kx} cy={ky} r="6" fill="#f59e0b" className="animate-ping" />
                                            <circle cx={kx} cy={ky} r="4" fill="#f59e0b" />
                                        </g>
                                    );
                                })()}
                            </svg>

                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <div className="bg-[#090a0f] border border-zinc-800 px-5 py-4 rounded-xl text-center shadow-2xl">
                                    <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-black mb-1">Consolidated Slots</p>
                                    <p className="text-lg font-black text-white">{state.ring.length} Active Nodes</p>
                                </div>
                            </div>
                            
                            <div className="absolute bottom-6 left-6 right-6">
                                {ringAnimation && (
                                    <div className="p-4 bg-[#090a0f] border border-zinc-800 rounded-lg text-[11px] text-center space-y-2 font-mono">
                                        <p className="text-zinc-400">
                                            Last transaction hashed at <span className="text-amber-500 font-bold">{ringAnimation.keyAngle}°</span> position.
                                        </p>
                                        <p className="text-zinc-500">
                                            Routing: Primary is <span className="text-zinc-200 font-bold">{ringAnimation.primaryId}</span>
                                            {ringAnimation.replicaId ? (
                                                <span>, Backup is <span className="text-zinc-200 font-bold">{ringAnimation.replicaId}</span></span>
                                            ) : ''}
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Unified Event Logs Footer */}
                <section className="bg-[#151618] border border-zinc-800 rounded-xl p-6 shadow-lg">
                    <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-4">
                        <h2 className="text-sm font-bold tracking-widest uppercase text-zinc-400">System Logs</h2>
                        <button 
                            onClick={() => setState(prev => ({ ...prev, logs: [`[${new Date().toLocaleTimeString()}] Logs cleared.`] }))}
                            className="text-[11px] font-bold hover:text-zinc-200 text-zinc-500 flex items-center gap-1.5 transition-colors uppercase tracking-wider"
                        >
                            <RotateCcw size={12} /> Clear Logs
                        </button>
                    </div>
                    
                    <div className="h-40 overflow-y-auto font-mono text-[11px] space-y-3 pr-2">
                        {state.logs.map((log, index) => {
                            let logColor = 'text-zinc-400';
                            if (log.includes('❌') || log.includes('DEAD')) logColor = 'text-rose-400 font-bold';
                            if (log.includes('✅')) logColor = 'text-emerald-400';
                            if (log.includes('🔄') || log.includes('⚠️')) logColor = 'text-amber-400';
                            if (log.includes('✍️')) logColor = 'text-blue-400';

                            return (
                                <div key={`${log}-${index}`} className={`flex items-start gap-3 ${logColor}`}>
                                    <span className="text-zinc-700 select-none">&gt;</span>
                                    <p className="leading-relaxed">{log}</p>
                                </div>
                            );
                        })}
                    </div>
                </section>
            </main>
        </div>
    );
}