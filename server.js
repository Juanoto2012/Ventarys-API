import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { Readable } from 'stream';

const app = express();
const PORT = 7860; // Recuerda configurar este mismo puerto en Koyeb

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// --- FUNCIÓN DE LOGS (RESPETANDO PRIVACIDAD) ---
function logError(providerId, reason) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ERROR] Proveedor: ${providerId} | Motivo: ${reason}`);
}

// --- CONFIGURACIÓN DE PROVEEDORES ---
// Dejamos únicamente a llm7.io
const PROVIDERS = [
    { 
        id: "llm7", 
        url: "https://api.llm7.io/v1/chat/completions" 
    }
];

const MAX_PER_PROVIDER = 3; 
const QUEUE_TIMEOUT = 25000; 

const BLOCKED_TIERS = ["pro", "premium", "ultra", "vip", "plus", "enterprise", "max"];

function isModelAllowed(modelId, modelObj = null) {
    if (!modelId) return true; 
    const lowerId = modelId.toLowerCase();
    if (modelObj && modelObj.tier) {
        const tier = modelObj.tier.toLowerCase();
        if (tier === "pro" || tier === "premium" || tier === "vip") return false;
        if (tier === "free" || tier === "standard") return true;
    }
    return !BLOCKED_TIERS.some(keyword => lowerId.includes(keyword));
}

// Solo rastreamos la carga de llm7
let currentLoad = { "llm7": 0 };

const limiter = rateLimit({
    windowMs: 60 * 1000, 
    max: 25, 
    message: { error: { message: "Límite alcanzado. Espera 1 minuto entre mensajes.", code: 429 } },
    standardHeaders: true,
    legacyHeaders: false,
});

// --- RUTAS INFORMATIVAS ---
app.get('/health', (req, res) => {
    res.json({ 
        status: "online", 
        type: "koyeb-node-proxy", // Cambiado para reflejar tu nuevo host
        providers: PROVIDERS.map(p => p.id),
        current_load: currentLoad 
    });
});

app.get('/v1/models', async (req, res) => {
    try {
        const fetchPromises = PROVIDERS.map(async (provider) => {
            const modelsUrl = provider.modelsUrl || provider.url.replace("/chat/completions", "/models");
            const fetchHeaders = { "Content-Type": "application/json" };
            
            if (provider.apiKey) fetchHeaders["Authorization"] = `Bearer ${provider.apiKey}`;
            if (provider.proxySecret) fetchHeaders["X-Proxy-Secret"] = provider.proxySecret;

            const resp = await fetch(modelsUrl, { method: "GET", headers: fetchHeaders });
            if (!resp.ok) {
                logError(provider.id, `Fallo al recuperar modelos (HTTP ${resp.status})`);
                throw new Error(`HTTP Error ${resp.status}`);
            }
            
            const json = await resp.json();
            let modelsArray = [];

            if (Array.isArray(json)) {
                modelsArray = json; 
            } else if (json && Array.isArray(json.data)) {
                modelsArray = json.data; 
            }

            if (modelsArray.length > 0) {
                return modelsArray
                    .filter(model => isModelAllowed(model.id || model.name, model))
                    .map(model => ({
                        ...model,
                        id: model.id || model.name,
                        owned_by: provider.id 
                    }));
            }
            return [];
        });

        const results = await Promise.allSettled(fetchPromises);
        let allModels = [];
        results.forEach(result => {
            if (result.status === "fulfilled") allModels = allModels.concat(result.value);
        });

        res.json({ object: "list", data: allModels });
    } catch (error) {
        logError("ProxyMain", "Error crítico al agrupar la lista de modelos.");
        res.status(500).json({ error: "No se pudieron recuperar los modelos." });
    }
});

// --- RUTA PRINCIPAL DE GENERACIÓN ---
app.post(['/v1/chat/completions', '/v1/images/generations'], limiter, async (req, res) => {
    const isImage = req.path === '/v1/images/generations';
    const requestedModel = req.body.model;

    if (requestedModel && !isModelAllowed(requestedModel)) {
        logError("ProxyMain", `Bloqueado intento de uso de modelo premium: ${requestedModel}`);
        return res.status(403).json({
            error: { 
                message: `Acceso denegado: El modelo '${requestedModel}' es de pago (Premium/Pro).`, 
                type: "model_not_allowed", code: 403 
            }
        });
    }

    const availableProviders = isImage ? PROVIDERS.filter(p => p.imageUrl) : PROVIDERS;
    const startTime = Date.now();
    let selectedProvider = null;

    while (Date.now() - startTime < QUEUE_TIMEOUT) {
        let shuffled = [...availableProviders].sort(() => Math.random() - 0.5);
        for (let provider of shuffled) {
            if (currentLoad[provider.id] < MAX_PER_PROVIDER) {
                selectedProvider = provider;
                currentLoad[provider.id]++;
                break;
            }
        }
        if (selectedProvider) break;
        await new Promise(r => setTimeout(r, 1500));
    }

    if (!selectedProvider) {
        logError("ProxyMain", "Saturación - La API está ocupada (Cola llena)");
        return res.status(503).json({ error: { message: "La API está ocupada. Por favor, reintenta.", code: 503 } });
    }

    let isReleased = false;
    const releaseSlot = () => {
        if (!isReleased) {
            currentLoad[selectedProvider.id] = Math.max(0, currentLoad[selectedProvider.id] - 1);
            isReleased = true;
        }
    };

    try {
        const targetUrl = isImage ? selectedProvider.imageUrl : selectedProvider.url;
        const fetchHeaders = { "Content-Type": "application/json" };
        
        if (selectedProvider.apiKey) fetchHeaders["Authorization"] = `Bearer ${selectedProvider.apiKey}`;
        if (selectedProvider.proxySecret) fetchHeaders["X-Proxy-Secret"] = selectedProvider.proxySecret;

        const response = await fetch(targetUrl, {
            method: "POST",
            headers: fetchHeaders,
            body: JSON.stringify(req.body)
        });

        if (!response.ok) {
            logError(selectedProvider.id, `Respuesta HTTP ${response.status} - ${response.statusText}`);
        }

        // --- MANEJO DE IMÁGENES (Conversión a Base64) ---
        if (isImage) {
            const contentType = response.headers.get("content-type") || "";

            if (contentType.includes("application/json")) {
                const jsonResp = await response.json();
                
                if (jsonResp.data && Array.isArray(jsonResp.data)) {
                    for (let item of jsonResp.data) {
                        if (item.url && !item.b64_json) {
                            try {
                                const imgRes = await fetch(item.url);
                                const arrayBuffer = await imgRes.arrayBuffer();
                                item.b64_json = Buffer.from(arrayBuffer).toString('base64');
                                delete item.url; 
                            } catch (e) {
                                logError(selectedProvider.id, `Fallo al convertir la URL de imagen a Base64: ${e.message}`);
                            }
                        }
                    }
                }
                releaseSlot();
                return res.status(response.status).json(jsonResp);
            } 
            else if (contentType.includes("image/")) {
                const arrayBuffer = await response.arrayBuffer();
                const b64 = Buffer.from(arrayBuffer).toString('base64');
                releaseSlot();
                
                return res.status(200).json({
                    created: Math.floor(Date.now() / 1000),
                    data: [{ b64_json: b64 }]
                });
            } 
            else {
                const textResp = await response.text();
                releaseSlot();
                return res.status(response.status).type(contentType).send(textResp);
            }
        } 
        
        // --- MANEJO DE CHAT (Streaming) ---
        res.writeHead(response.status, {
            'Content-Type': response.headers.get('content-type') || 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        if (response.body) {
            const stream = Readable.fromWeb(response.body);
            stream.pipe(res);
            
            stream.on('end', releaseSlot);
            stream.on('error', (err) => {
                logError(selectedProvider.id, `Stream roto a mitad de la respuesta: ${err.message}`);
                releaseSlot();
            });
            req.on('close', releaseSlot); 
        } else {
            releaseSlot();
            res.end();
        }

    } catch (err) {
        releaseSlot();
        logError(selectedProvider.id, `Fallo de red o Timeout conectando al proveedor: ${err.message}`);
        res.status(500).json({ error: `Error de conexión interna.` });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API Proxy (Node.js) corriendo seguro en el puerto ${PORT}`);
});
