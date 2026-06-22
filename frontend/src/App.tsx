import { useEffect, useState, useRef } from 'react';
import {
    Activity,
    Server,
    Database,
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
    data: Map<string, { value: any; expiresAt: number | null }>; // For local simulation
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
    const [ringAnimation, setRingAnimation] = useState<{ id: number; keyHash: number; keyAngle: number; primaryId: string; replicaId: string } | null>(null);
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
                ::-webkit-scrollbar {
                    width: 6px;
                }
                ::-webkit-scrollbar-track {
                    background: #151618;
                }
                ::-webkit-scrollbar-thumb {
                    background: #27272a;
                    border-radius: 3px;
                }
            `;
            document.head.appendChild(style);
            tailwindInjected.current = true;
        }
    }, []);

    // --- 2. LOCAL SIMULATION ENGINE (Fallback if backend is off) ---
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

    // Calculate MD5-style Hash Angle mathematically mimicking the backend
    const getSimHashAngle = (str: string): number => {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        // Normalize to 360 degrees
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
                metrics: { hits: 0, misses: 0, keys: 0 },
                data: new Map()
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
                `[${new Date().toLocaleTimeString()}] 🚀 Frontend initialized.`
            ]
        });
    };

    // --- 3. CORE API CALLS & ANIMATIONS ---
    const handleSimulateSet = async (key: string, val: string, ttlMs: number) => {
        if (!key || !val) return;
        
        // Update input boxes to visually show the bot typing
        setInputKey(key);
        setInputValue(val);

        if (isConnected) {
            try {
                const res = await fetch(`http://localhost:3000/cache/${key}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ value: val, ttl: ttlMs })
                });
                const data = await res.json();
                
                if (data.primary) {
                    const primaryNode = state.ring.find(n => n.nodeId === data.primary);
                    if (primaryNode) {
                        setRingAnimation({
                            id: Date.now(), // Unique ID forces animation remount
                            keyHash: 0,
                            keyAngle: (primaryNode.angle - 15 + 360) % 360,
                            primaryId: data.primary,
                            replicaId: data.replica || ''
                        });
                    }
                }
            } catch (err) {
                console.error("Live write failed", err);
            }
            return;
        }

        // Offline Simulation Fallback
        const keyAngle = getSimHashAngle(key);
        const activeRing = state.ring.filter(r => {
            const node = simulationState.current.nodes?.get(r.nodeId);
            return node && node.status === 'Healthy';
        });

        if (activeRing.length === 0) {
            addSimLog(`❌ WRITE FAILED: No healthy cache nodes available.`);
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

        setRingAnimation({
            id: Date.now(),
            keyHash: keyAngle * 1000,
            keyAngle,
            primaryId,
            replicaId
        });

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
                addSimLog(`✍️ Write: "${key}" -> Routed to [${primaryId}] & Replicated to [${replicaId}]`);
            }
        }

        setState(prev => ({ ...prev, nodes: Array.from(simulationState.current.nodes.values()) }));
    };

    const handleSimulateGet = async (key: string) => {
        if (!key) return;
        
        // Show what the bot is fetching in the UI
        setSearchKey(key);

        if (isConnected) {
            try {
                const res = await fetch(`http://localhost:3000/cache/${key}`);
                if (res.ok) {
                    const data = await res.json();
                    setSearchResult({ found: true, value: data.value, source: `Live Cluster` });
                } else {
                    setSearchResult({ found: false, error: 'Key not found in cluster.' });
                }
                
                const activeNodes = state.ring;
                if (activeNodes.length > 0) {
                    // Visually ping near a random node for live fetches
                    const displayNode = activeNodes[Math.floor(Math.random() * activeNodes.length)];
                    setRingAnimation({ 
                        id: Date.now(), 
                        keyHash: 0, 
                        keyAngle: (displayNode.angle - 15 + 360) % 360, 
                        primaryId: 'Live-Router', 
                        replicaId: '' 
                    });
                }
            } catch (err) {
                setSearchResult({ found: false, error: 'Failed to communicate with cluster.' });
            }
            return;
        }

        // Offline Simulation Fallback
        const keyAngle = getSimHashAngle(key);
        const activeRing = state.ring.filter(r => {
            const node = simulationState.current.nodes?.get(r.nodeId);
            return node && node.status === 'Healthy';
        });

        if (activeRing.length === 0) {
            setSearchResult({ found: false, error: 'No active nodes in cluster' });
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

        setRingAnimation({
            id: Date.now(),
            keyHash: keyAngle * 1000,
            keyAngle,
            primaryId,
            replicaId
        });

        const primaryNode = simulationState.current.nodes.get(primaryId);
        const item = primaryNode?.data.get(key);

        if (item && (item.expiresAt === null || Date.now() < item.expiresAt)) {
            if (primaryNode) primaryNode.metrics.hits++;
            setSearchResult({ found: true, value: item.value, source: `${primaryId} (Primary)` });
            addSimLog(`🔍 Cache Hit: "${key}" on [${primaryId}]`);
        } else {
            if (primaryNode) primaryNode.metrics.misses++;
            
            if (replicaId) {
                const replicaNode = simulationState.current.nodes.get(replicaId);
                const replicaItem = replicaNode?.data.get(key);

                if (replicaItem && (replicaItem.expiresAt === null || Date.now() < replicaItem.expiresAt)) {
                    if (replicaNode) replicaNode.metrics.hits++;
                    setSearchResult({ found: true, value: replicaItem.value, source: `${replicaId} (Replica)` });
                    addSimLog(`⚠️ Failover Read: Fetched "${key}" from Replica [${replicaId}]`);
                } else {
                    if (replicaNode) replicaNode.metrics.misses++;
                    setSearchResult({ found: false, error: 'Key not found anywhere.' });
                }
            } else {
                setSearchResult({ found: false, error: 'Key not found.' });
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
            addSimLog(`❌ Node [${nodeId}] simulated CRASH!`);
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
            addSimLog(`✅ Node [${nodeId}] recovered!`);
        }
    };

    // --- 4. DATA SYNC & LOOP RUNNERS ---
    useEffect(() => {
        initializeSimulation();

        const fetchState = async () => {
            try {
                const res = await fetch('http://localhost:3000/api/dashboard');
                if (res.ok) {
                    const data = await res.json();
                    
                    // Standardize mathematically correct Ring Angles mapping to backend MD5
                    const maxHashValue = 4294967295; 
                    const updatedRing = data.ring.map((rn: any) => ({
                        ...rn,
                        angle: Math.floor((rn.hash / maxHashValue) * 360)
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

        fetchState();
        const interval = setInterval(fetchState, 2500);
        return () => clearInterval(interval);
    }, []);

    // Simulated Auto-Traffic Loop
    useEffect(() => {
        if (!autoTraffic) return;

        const interval = setInterval(() => {
            const demoKeys = ['user-profile', 'auth-token', 'product-list', 'pricing-tier', 'session-meta', 'cart-payload'];
            const randomKey = demoKeys[Math.floor(Math.random() * demoKeys.length)];
            
            // 70% Read / 30% Write Split for realistic load
            if (Math.random() > 0.7) {
                handleSimulateSet(randomKey, `val-${Math.floor(Math.random() * 1000)}`, 60000);
            } else {
                handleSimulateGet(randomKey);
            }
        }, 1200); // 1.2 seconds for rapid visible testing!

        return () => clearInterval(interval);
    }, [autoTraffic, state.ring, isConnected]);

    // Derived Statistics
    const activeNodes = state.nodes.filter(n => n.status === 'Healthy');
    const deadNodesCount = state.nodes.length - activeNodes.length;
    const totalKeys = activeNodes.reduce((acc, curr) => acc + (curr.metrics?.keys || 0), 0);
    const totalHits = state.nodes.reduce((acc, curr) => acc + (curr.metrics?.hits || 0), 0);
    const totalMisses = state.nodes.reduce((acc, curr) => acc + (curr.metrics?.misses || 0), 0);

    return (
        <div className="min-h-screen bg-[#090a0f] text-zinc-300 flex flex-col font-sans selection:bg-blue-500/30">
            {/* Header / Brand Bar */}
            <header className="border-b border-zinc-800/80 bg-[#090a0f]/95 backdrop-blur-md sticky top-0 z-50 px-6 py-4 flex items-center justify-between shadow-md">
                <div className="flex items-center gap-3">
                    <div className="bg-blue-600 p-2 rounded-lg shadow-lg shadow-blue-900/50">
                        <Activity className="text-white w-5 h-5" />
                    </div>
                    <div className="flex items-center gap-3">
                        <h1 className="text-xl font-black tracking-tight text-white">RevCache</h1>
                        <div className="w-px h-5 bg-zinc-800 hidden sm:block"></div>
                        <p className="text-xs text-zinc-400 font-medium tracking-wide hidden sm:block">Self-Healing Distributed Cache System</p>
                    </div>
                </div>

                {/* Connection Status */}
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-[11px] font-bold tracking-widest uppercase shadow-sm ${
                    isConnected 
                        ? 'bg-emerald-950/30 border-emerald-500/20 text-emerald-400' 
                        : 'bg-amber-950/30 border-amber-500/20 text-amber-400'
                }`}>
                    <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                    {isConnected ? 'LIVE BACKEND' : 'SIMULATION MODE'}
                </div>
            </header>

            <main className="flex-1 max-w-[1400px] w-full mx-auto p-6 space-y-6">
                
                {/* 1. TOP METRICS ROW */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-[#151618] border border-zinc-800/80 rounded-xl p-4 shadow-xl">
                        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Cluster Health</p>
                        <div className="flex items-end justify-between mt-2">
                            <h3 className="text-2xl font-black text-white">{activeNodes.length} <span className="text-base text-zinc-600">/ {state.nodes.length}</span></h3>
                            <Server className="w-5 h-5 text-blue-500/50 mb-1" />
                        </div>
                        <p className="text-[10px] text-zinc-500 mt-2">Active cache nodes</p>
                    </div>

                    <div className="bg-[#151618] border border-zinc-800/80 rounded-xl p-4 shadow-xl">
                        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Cached Keys</p>
                        <div className="flex items-end justify-between mt-2">
                            <h3 className="text-2xl font-black text-white">{totalKeys}</h3>
                            <Database className="w-5 h-5 text-indigo-500/50 mb-1" />
                        </div>
                        <p className="text-[10px] text-zinc-500 mt-2">Distributed globally</p>
                    </div>

                    <div className="bg-[#151618] border border-zinc-800/80 rounded-xl p-4 shadow-xl">
                        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Hit Ratio</p>
                        <div className="flex items-end justify-between mt-2">
                            <h3 className="text-2xl font-black text-emerald-400">
                                {totalHits + totalMisses > 0 ? `${((totalHits / (totalHits + totalMisses)) * 100).toFixed(1)}%` : '100%'}
                            </h3>
                            <Zap className="w-5 h-5 text-emerald-500/50 mb-1" />
                        </div>
                        <p className="text-[10px] text-emerald-500/60 mt-2">{totalHits} total hits</p>
                    </div>

                    <div className="bg-[#151618] border border-zinc-800/80 rounded-xl p-4 shadow-xl">
                        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Failed Nodes</p>
                        <div className="flex items-end justify-between mt-2">
                            <h3 className={`text-2xl font-black ${deadNodesCount > 0 ? 'text-rose-500 animate-pulse' : 'text-zinc-600'}`}>
                                {deadNodesCount}
                            </h3>
                            <XCircle className="w-5 h-5 text-rose-500/30 mb-1" />
                        </div>
                        <p className="text-[10px] text-zinc-500 mt-2">Self-healing ready</p>
                    </div>
                </div>

                {/* 2. INTERACTIVE OPERATIONS DECK (Full Width Horizontal Grid) */}
                <section className="bg-[#151618] border border-zinc-800/80 rounded-xl p-6 shadow-xl grid grid-cols-1 lg:grid-cols-12 gap-6">
                    {/* Write */}
                    <div className="lg:col-span-4 space-y-4">
                        <div className="flex items-center gap-2">
                            <span className="bg-indigo-500/20 text-indigo-400 p-1 rounded border border-indigo-500/20"><Plus size={14} /></span>
                            <h3 className="font-bold text-white text-sm">Simulate Cache Set (Write)</h3>
                        </div>
                        <div className="space-y-3">
                            <input 
                                type="text" placeholder="Enter Key (e.g., config-meta)" 
                                value={inputKey} onChange={(e) => setInputKey(e.target.value)}
                                className="w-full bg-[#090a0f] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                            />
                            <input 
                                type="text" placeholder="Enter Value String" 
                                value={inputValue} onChange={(e) => setInputValue(e.target.value)}
                                className="w-full bg-[#090a0f] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                            />
                            <div className="flex items-center gap-3">
                                <span className="text-xs text-zinc-500">TTL:</span>
                                <select 
                                    value={inputTtl} onChange={(e) => setInputTtl(e.target.value)}
                                    className="flex-1 bg-[#090a0f] border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-300 focus:outline-none"
                                >
                                    <option value="10000">10 Seconds</option>
                                    <option value="60000">1 Minute</option>
                                    <option value="3600000">1 Hour</option>
                                    <option value="0">No Expiration</option>
                                </select>
                            </div>
                            <button 
                                onClick={() => handleSimulateSet(inputKey, inputValue, parseInt(inputTtl))}
                                className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 rounded-lg text-sm transition-all"
                            >
                                Write to Cache Ring
                            </button>
                        </div>
                    </div>

                    {/* Read */}
                    <div className="lg:col-span-4 space-y-4 border-t lg:border-t-0 lg:border-x border-zinc-800/80 lg:px-6 pt-4 lg:pt-0">
                        <div className="flex items-center gap-2">
                            <span className="bg-emerald-500/20 text-emerald-400 p-1 rounded border border-emerald-500/20"><Search size={14} /></span>
                            <h3 className="font-bold text-white text-sm">Manual Read</h3>
                        </div>
                        <div className="flex gap-2">
                            <input 
                                type="text" placeholder="Key to fetch..." 
                                value={searchKey} onChange={(e) => setSearchKey(e.target.value)}
                                className="flex-1 bg-[#090a0f] border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                            />
                            <button 
                                onClick={() => handleSimulateGet(searchKey)}
                                className="bg-zinc-800 hover:bg-zinc-700 text-white font-bold px-4 py-2 rounded-lg text-sm transition-all border border-zinc-700"
                            >
                                Fetch
                            </button>
                        </div>
                        <div className="bg-[#090a0f] border border-zinc-800/80 rounded-lg p-3 h-[90px] overflow-y-auto flex flex-col justify-center text-xs">
                            {searchResult ? (
                                searchResult.found ? (
                                    <div>
                                        <div className="flex justify-between mb-1">
                                            <span className="text-emerald-400 font-bold uppercase tracking-wider text-[10px]">HIT Found</span>
                                            <span className="text-zinc-500 text-[10px]">{searchResult.source}</span>
                                        </div>
                                        <p className="text-white font-mono break-all bg-[#151618] px-2 py-1 rounded border border-zinc-800">{searchResult.value}</p>
                                    </div>
                                ) : (
                                    <div className="text-center text-rose-400">{searchResult.error}</div>
                                )
                            ) : (
                                <div className="text-center text-zinc-600 italic">Awaiting query...</div>
                            )}
                        </div>
                    </div>

                    {/* Auto Traffic */}
                    <div className="lg:col-span-4 space-y-4 pt-4 lg:pt-0">
                        <div className="flex items-center gap-2">
                            <span className="bg-amber-500/20 text-amber-400 p-1 rounded border border-amber-500/20"><Zap size={14} /></span>
                            <h3 className="font-bold text-white text-sm">Load Tester</h3>
                        </div>
                        <p className="text-[11px] text-zinc-400 leading-relaxed">
                            Automate read/write transactions to stress test topology. Observe real-time self-healing capabilities when combined with manual node kills.
                        </p>
                        <button 
                            onClick={() => setAutoTraffic(!autoTraffic)}
                            className={`w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-black tracking-wide transition-all shadow-md ${
                                autoTraffic 
                                    ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20 hover:bg-rose-500/20' 
                                    : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20'
                            }`}
                        >
                            {autoTraffic ? <Pause size={16} /> : <Play size={16} />}
                            {autoTraffic ? 'Halt Auto-Traffic' : 'Start Auto-Traffic'}
                        </button>
                    </div>
                </section>

                {/* 3. SPLIT VIEW: Nodes (Left) & Visualizer/Logs (Right) */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    
                    {/* LEFT SIDE: Node Cards */}
                    <div className="lg:col-span-7 space-y-4">
                        <h2 className="text-base font-bold text-white flex items-center gap-2 mb-2">
                            <Server size={16} className="text-blue-500" /> Live Node Memory
                        </h2>
                        {state.nodes.map(node => (
                            <div key={node.id} className={`bg-[#151618] border rounded-xl p-5 transition-all shadow-lg overflow-hidden relative ${
                                node.status === 'Healthy' ? 'border-zinc-800/80' : 'border-rose-900/30 bg-[#1a0f14]'
                            }`}>
                                {/* Status Indicator Strip */}
                                <div className={`absolute left-0 top-0 bottom-0 w-1 ${node.status === 'Healthy' ? 'bg-emerald-500/50' : 'bg-rose-500 animate-pulse'}`}></div>

                                <div className="flex justify-between items-start pl-2">
                                    <div>
                                        <div className="flex items-center gap-3">
                                            <h3 className="text-lg font-black text-white">{node.id}</h3>
                                            <span className={`text-[9px] uppercase tracking-widest font-black px-2 py-0.5 rounded border ${
                                                node.status === 'Healthy' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                                            }`}>
                                                {node.status}
                                            </span>
                                        </div>
                                        <p className="text-xs font-mono text-zinc-500 mt-1">{node.url}</p>
                                    </div>
                                    <div className="flex flex-col sm:flex-row items-end sm:items-center gap-3">
                                        <span className="text-xs text-zinc-500 font-mono flex items-center gap-1">
                                            <Clock size={12} /> Seen: {Math.floor((Date.now() - node.lastHeartbeat) / 1000)}s
                                        </span>
                                        <button 
                                            onClick={() => toggleNodeStatusSim(node.id)}
                                            className={`text-xs font-bold px-3 py-1.5 rounded-md transition-all border ${
                                                node.status === 'Healthy' 
                                                    ? 'bg-rose-950/30 text-rose-400 border-rose-900/50 hover:bg-rose-900/50 hover:text-rose-300' 
                                                    : 'bg-emerald-950/30 text-emerald-400 border-emerald-900/50 hover:bg-emerald-900/50 hover:text-emerald-300'
                                            }`}
                                        >
                                            {node.status === 'Healthy' ? 'Kill Node' : 'Revive Node'}
                                        </button>
                                    </div>
                                </div>

                                {/* Node Metrics Grid */}
                                {node.status === 'Healthy' ? (
                                    <div className="grid grid-cols-3 gap-3 mt-4 pl-2">
                                        <div className="bg-[#090a0f] p-2.5 rounded-lg border border-zinc-800/50 text-center">
                                            <p className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold">Metrics Keys</p>
                                            <p className="text-lg font-black text-white mt-0.5">{node.metrics?.keys || 0}</p>
                                        </div>
                                        <div className="bg-[#090a0f] p-2.5 rounded-lg border border-zinc-800/50 text-center">
                                            <p className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold">Hits</p>
                                            <p className="text-lg font-black text-emerald-400 mt-0.5">{node.metrics?.hits || 0}</p>
                                        </div>
                                        <div className="bg-[#090a0f] p-2.5 rounded-lg border border-zinc-800/50 text-center">
                                            <p className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold">Misses</p>
                                            <p className="text-lg font-black text-rose-400 mt-0.5">{node.metrics?.misses || 0}</p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="mt-4 pl-2 text-xs text-rose-400/70 italic text-center py-2 bg-rose-950/20 rounded border border-rose-900/20">
                                        Node is offline. Traffic is bypassing to replicas.
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {/* RIGHT SIDE: Hash Ring & Logs */}
                    <div className="lg:col-span-5 space-y-6 flex flex-col">
                        
                        {/* Ring Visualizer */}
                        <div className="bg-[#151618] border border-zinc-800/80 rounded-xl p-5 shadow-xl flex-1 flex flex-col">
                            <h2 className="text-sm font-bold text-white flex items-center gap-2 mb-4">
                                <Clock size={16} className="text-indigo-400" /> Topology Hash Ring
                            </h2>
                            
                            <div className="flex-1 flex flex-col items-center justify-center relative min-h-[280px]">
                                <svg width="280" height="280" className="relative transform rotate-[-90deg]">
                                    <circle cx="140" cy="140" r="105" fill="transparent" stroke="#1e2024" strokeWidth="3" className="pulse-effect" />
                                    <circle cx="140" cy="140" r="105" fill="transparent" stroke="#27272a" strokeWidth="1" strokeDasharray="4 4" />
                                    
                                    {state.ring.map((ringNode, index) => {
                                        const rad = (ringNode.angle * Math.PI) / 180;
                                        const x = 140 + 105 * Math.cos(rad);
                                        const y = 140 + 105 * Math.sin(rad);
                                        const nodeColor = ringNode.nodeId === 'node-1' ? '#3b82f6' : ringNode.nodeId === 'node-2' ? '#a855f7' : '#ec4899';
                                        
                                        return (
                                            <g key={`phys-${ringNode.nodeId}-${index}`}>
                                                <circle cx={x} cy={y} r="10" fill="#090a0f" stroke={nodeColor} strokeWidth="3" />
                                                <circle cx={x} cy={y} r="4" fill={nodeColor} />
                                            </g>
                                        );
                                    })}

                                    {ringAnimation && (() => {
                                        const keyRad = (ringAnimation.keyAngle * Math.PI) / 180;
                                        const kx = 140 + 105 * Math.cos(keyRad);
                                        const ky = 140 + 105 * Math.sin(keyRad);
                                        return (
                                            <g key={ringAnimation.id}>
                                                <circle cx={kx} cy={ky} r="7" fill="#f59e0b" className="animate-ping" />
                                                <circle cx={kx} cy={ky} r="4" fill="#f59e0b" />
                                            </g>
                                        );
                                    })()}
                                </svg>

                                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                    <div className="bg-[#090a0f]/90 border border-zinc-800 px-4 py-2 rounded-lg text-center shadow-xl backdrop-blur-sm">
                                        <p className="text-[9px] text-zinc-500 uppercase tracking-widest font-black">Consolidated Slots</p>
                                        <p className="text-lg font-black text-white mt-0.5">{state.ring.length} Active Nodes</p>
                                    </div>
                                </div>
                            </div>

                            {ringAnimation && (
                                <div className="mt-4 pt-4 border-t border-zinc-800/50 text-center space-y-1 bg-[#090a0f] rounded-lg py-2 border border-zinc-800/30">
                                    <p className="text-[10px] text-zinc-400 font-mono uppercase tracking-wider">
                                        Action hashed at <span className="text-amber-400 font-bold">{ringAnimation.keyAngle}°</span>
                                    </p>
                                    <p className="text-[10px] text-zinc-500 font-mono">
                                        Primary: <span className="text-white">{ringAnimation.primaryId}</span>
                                        {ringAnimation.replicaId ? ` | Backup: ${ringAnimation.replicaId}` : ''}
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* Console Logs */}
                        <div className="bg-[#151618] border border-zinc-800/80 rounded-xl p-5 shadow-xl h-[280px] flex flex-col">
                            <div className="flex items-center justify-between mb-3 border-b border-zinc-800/50 pb-2">
                                <h3 className="font-bold text-white flex items-center gap-2 text-sm">
                                    <Database size={16} className="text-zinc-400" /> System Logs
                                </h3>
                                <button onClick={() => setState(p => ({ ...p, logs: [] }))} className="text-zinc-600 hover:text-white transition-colors">
                                    <RotateCcw size={14} />
                                </button>
                            </div>
                            
                            <div className="flex-1 overflow-y-auto font-mono text-[10px] space-y-2.5 pr-2">
                                {state.logs.map((log, index) => {
                                    let color = 'text-zinc-400';
                                    if (log.includes('❌')) color = 'text-rose-400';
                                    if (log.includes('✅')) color = 'text-emerald-400';
                                    if (log.includes('🔄') || log.includes('⚠️')) color = 'text-amber-400';
                                    if (log.includes('✍️')) color = 'text-blue-400';

                                    return (
                                        <div key={index} className={`leading-relaxed flex gap-2 ${color}`}>
                                            <span className="opacity-50">&gt;</span>
                                            <span>{log}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                    </div>
                </div>
            </main>
        </div>
    );
}