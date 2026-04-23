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

// 1. REST API 端點
app.post('/api/summary', async (req, res) => {
    try {
        const { prompt } = req.body;
        const modelId = GEMINI_MODEL_NAME.replace('models/', '');
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

// 2. WebSocket 伺服器 - 簡化版本
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
    console.log(`[新連線] 準備代理至模型: ${GEMINI_MODEL_NAME}`);

    if (!GEMINI_API_KEY) {
        clientWs.close(1011, "後端未設定 API Key");
        return;
    }

    // 使用更穩定的模型
    const stableModel = 'models/gemini-2.0-flash-exp';
    console.log(`使用穩定模型: ${stableModel}`);

    const geminiWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    const geminiWs = new WebSocket(geminiWsUrl);

    let isConnected = false;

    geminiWs.on('open', () => {
        console.log('已成功連上 Gemini Live API');
        isConnected = true;

        // 發送簡單的初始化訊息
        const setupMessage = {
            setup: {
                model: stableModel,
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