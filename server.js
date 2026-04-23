const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const cors = require('cors');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || 'models/gemini-2.0-flash-exp';

if (!GEMINI_API_KEY) {
    console.error("警告：未設定 GEMINI_API_KEY 環境變數！");
}

// 1. REST API 端點 - 用於摘要功能
app.post('/api/summary', async (req, res) => {
    try {
        const { prompt } = req.body;
        // 使用支援 generateContent 的穩定模型
        const modelId = 'gemini-2.0-flash-exp';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`;

        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: "你是一個專業且高效率的教育助理。請嚴格遵守要求的格式與精簡度。" }] }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error?.message || 'Gemini API 回傳錯誤');
        }

        res.json(data);
    } catch (error) {
        console.error('摘要 API 錯誤:', error);
        res.status(500).json({ error: error.message });
    }
});

// 測試端點：檢查支援 Live API 的模型
app.get('/api/models', async (req, res) => {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || '無法獲取模型列表');
        }

        const liveModels = data.models.filter(model =>
            model.supportedGenerationMethods &&
            model.supportedGenerationMethods.includes('bidiGenerateContent')
        );

        res.json({
            liveModels: liveModels.map(m => m.name),
            allModels: data.models.map(m => ({
                name: m.name,
                methods: m.supportedGenerationMethods || []
            }))
        });
    } catch (error) {
        console.error('檢查模型失敗:', error);
        res.status(500).json({ error: error.message });
    }
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// 輔助函數：檢查模型是否可用
async function findAvailableLiveModel(apiKey) {
    const liveModels = [
        'models/gemini-2.5-flash-live-preview-0924',
        'models/gemini-3.1-flash-live-preview',
        'models/gemini-2.5-flash-native-audio-preview-12-2025',
        'models/gemini-2.5-flash-live-preview-09-2025'
    ];

    console.log('開始檢查支援 Live API 的模型...');

    for (const model of liveModels) {
        try {
            console.log(`測試模型: ${model}`);
            const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model.replace('models/', '')}:generateContent?key=${apiKey}`;
            const testResponse = await fetch(testUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: "test" }] }]
                })
            });

            if (testResponse.ok) {
                console.log(`✅ 找到可用的 Live API 模型: ${model}`);
                return model;
            } else {
                const errorData = await testResponse.json();
                console.log(`❌ 模型 ${model} 不可用:`, errorData.error?.message);
            }
        } catch (e) {
            console.log(`❌ 測試模型 ${model} 失敗:`, e.message);
        }
    }

    console.log('❌ 沒有找到任何支援 Live API 的模型');
    return null; // 不使用備用模型，直接返回 null
}

wss.on('connection', async (clientWs) => {
    console.log(`[新連線] 準備代理至模型`);

    if (!GEMINI_API_KEY) {
        clientWs.close(1011, "後端未設定 API Key");
        return;
    }

    // 找到可用的 Live API 模型
    const selectedModel = await findAvailableLiveModel(GEMINI_API_KEY);

    if (!selectedModel) {
        console.log('沒有支援 Live API 的模型可用，關閉連線');
        const errorMsg = "您的 API 金鑰沒有權限使用 Gemini Live API，或 Live API 在您所在的地區不可用。請檢查 API 金鑰權限或考慮使用其他語音處理方案。";
        clientWs.send(JSON.stringify({
            serverError: errorMsg
        }));
        setTimeout(() => clientWs.close(1008, errorMsg), 500);
        return;
    }

    console.log(`使用模型: ${selectedModel}`);

    const geminiWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    const geminiWs = new WebSocket(geminiWsUrl);

    let isConnected = false;

    geminiWs.on('open', () => {
        console.log('已成功連上 Gemini Live API');
        isConnected = true;

        // 發送簡單的初始化訊息
        const setupMessage = {
            setup: {
                model: selectedModel,
                generationConfig: {
                    responseModalities: ["TEXT"]
                },
                systemInstruction: {
                    parts: [{ text: "你是一個即時聽寫與翻譯助理。請仔細聆聽使用者的語音。每次使用者說完一段話時，請輸出：[原音逐字稿]|||[規範現代漢語翻譯]" }]
                }
            }
        };

        try {
            geminiWs.send(JSON.stringify(setupMessage));
            console.log('已發送初始化訊息');
        } catch (e) {
            console.error('發送初始化訊息失敗:', e);
            clientWs.close(1011, "初始化失敗");
        }
    });

    geminiWs.on('message', (data) => {
        try {
            const response = JSON.parse(data.toString());
            console.log('收到 Gemini 訊息:', Object.keys(response));

            if (response.setupComplete) {
                console.log('Gemini 初始化完成');
            } else if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(data.toString());
            }
        } catch (e) {
            console.error('解析 Gemini 訊息失敗:', e);
        }
    });

    geminiWs.on('close', (code, reason) => {
        console.log(`Gemini WS 關閉 - Code: ${code}, Reason: ${reason}`);
        isConnected = false;
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(code, reason.toString());
        }
    });

    geminiWs.on('error', (err) => {
        console.error('Gemini WS 發生錯誤:', err);
        isConnected = false;
    });

    clientWs.on('message', (data) => {
        if (!isConnected) {
            console.log('Gemini 未連線，忽略訊息');
            return;
        }

        try {
            const msgStr = data.toString();
            const msgObj = JSON.parse(msgStr);

            // 忽略前端的 setup 訊息
            if (msgObj.setup) {
                console.log('忽略前端 setup 訊息');
                return;
            }

            // 轉換音訊格式
            if (msgObj.realtimeInput && msgObj.realtimeInput.mediaChunks) {
                const chunk = msgObj.realtimeInput.mediaChunks[0];
                if (chunk) {
                    const convertedMsg = {
                        realtimeInput: {
                            audio: {
                                data: chunk.data,
                                mimeType: chunk.mimeType
                            }
                        }
                    };
                    geminiWs.send(JSON.stringify(convertedMsg));
                    return;
                }
            }

            // 轉發其他訊息
            geminiWs.send(msgStr);
        } catch (e) {
            console.error('處理客戶端訊息失敗:', e);
        }
    });

    clientWs.on('close', () => {
        console.log('前端客戶端已斷線');
        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
        }
    });

    // 5秒後如果還沒連上就關閉
    setTimeout(() => {
        if (!isConnected && clientWs.readyState === WebSocket.OPEN) {
            console.log('連線逾時，關閉客戶端連線');
            clientWs.close(1008, "連線逾時");
        }
    }, 5000);
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});