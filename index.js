import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { Readable } from 'stream';

const app = express();
const PORT = process.env.PORT || 7860;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

function logError(providerId, reason) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ERROR] Proveedor: ${providerId} | Motivo: ${reason}`);
}

// --- CONFIGURACIÓN DE PROVEEDORES ---
const PROVIDERS = [
    { 
        id: "llm7", 
        url: "https://api.llm7.io/v1/chat/completions" 
    },
    {
        id: "pollinations",
        // Proveedor OpenAI compatible que funciona 100% SIN API KEY ni registros
        url: "https://text.pollinations.ai/v1/chat/completions",
        modelsUrl: "https://text.pollinations.ai/models"
    }
];

const MAX_PER_PROVIDER = 3; 
const QUEUE_TIMEOUT = 25000; 

// Filtro suavizado para que tus usuarios disfruten de todos los modelos gratis disponibles
const BLOCKED_TIERS = ["enterprise", "vip", "commercial_only"];

function isModelAllowed(modelId, modelObj = null) {
    if (!modelId) return true; 
    const lowerId = modelId.toLowerCase();
    
    if (modelObj && modelObj.tier) {
        const tier = modelObj.tier.toLowerCase();
        if (tier === "vip" || tier === "enterprise") return false;
        return true;
    }
    
    return !BLOCKED_TIERS.some(keyword => lowerId.includes(keyword));
}

// El balanceador ahora reparte la carga entre llm7 y pollinations
let currentLoad = { "llm7": 0, "pollinations": 0 };

const limiter = rateLimit({
    windowMs: 60 * 1000, 
    max: 25, 
    message: { error: { message: "Límite alcanzado. Espera 1 minuto.", code: 429 } },
    standardHeaders: true,
    legacyHeaders: false,
});

app.get('/health', (req, res) => {
    res.json({ 
        status: "online", 
        type: "zeabur-node-proxy",
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

            const resp = await fetch(modelsUrl, { method: "GET", headers: fetchHeaders });
            if (!resp.ok) throw new Error(`HTTP Error ${resp.status}`);
            
            const json = await resp.json();
            let modelsArray = [];

            if (Array.isArray(json)) modelsArray = json; 
            else if (json && Array.isArray(json.data)) modelsArray = json.data; 

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
        res.status(500).json({ error: "No se pudieron recuperar los modelos." });
    }
});

app.post(['/v1/chat/completions', '/v1/images/generations'], limiter, async (req, res) => {
    const isImage = req.path === '/v1/images/generations';
    const requestedModel = req.body.model;

    if (requestedModel && !isModelAllowed(requestedModel)) {
        return res.status(403).json({
            error: { message: `Acceso denegado: Este modelo requiere permisos especiales.`, code: 403 }
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
        return res.status(503).json({ error: { message: "API ocupada.", code: 503 } });
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

        const response = await fetch(targetUrl, {
            method: "POST",
            headers: fetchHeaders,
            body: JSON.stringify(req.body)
        });

        if (isImage) {
            const contentType = response.headers.get("content-type") || "";
            if (contentType.includes("application/json")) {
                const jsonResp = await response.json();
                releaseSlot();
                return res.status(response.status).json(jsonResp);
            }
            releaseSlot();
            return res.status(response.status).send(await response.text());
        } 
        
        res.writeHead(response.status, {
            'Content-Type': response.headers.get('content-type') || 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        if (response.body) {
            const stream = Readable.fromWeb(response.body);
            stream.pipe(res);
            stream.on('end', releaseSlot);
            stream.on('error', releaseSlot);
            req.on('close', releaseSlot); 
        } else {
            releaseSlot();
            res.end();
        }

    } catch (err) {
        releaseSlot();
        res.status(500).json({ error: `Error de conexión interna.` });
    }
});

app.use((req, res) => {
    res.status(404).json({ error: "Ruta no encontrada." });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API Proxy corriendo en el puerto ${PORT}`);
});