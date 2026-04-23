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

// 2. WebSocket 伺服器
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
    console.log(`[新連線] 準備代理至模型: ${GEMINI_MODEL_NAME}`);

    if (!GEMINI_API_KEY) {
        clientWs.close(1011, "後端未設定 API Key");
        return;
    }

    const geminiWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    const geminiWs = new WebSocket(geminiWsUrl);

    let isGeminiReady = false;
    const messageQueue = [];

    // 🔥 終極偵錯：攔截 Google 拒絕連線的真實原因
    geminiWs.on('unexpected-response', (req, res) => {
        let errorData = '';
        res.on('data', chunk => { errorData += chunk; });
        res.on('end', () => {
            console.error(`[連線被拒] Google API HTTP ${res.statusCode}:`, errorData);
            if (clientWs.readyState === WebSocket.OPEN) {
                // 將 Google 的錯誤訊息包裝送回給前端
                clientWs.send(JSON.stringify({
                    serverError: `Google 伺服器拒絕連線 (HTTP ${res.statusCode})。\n設定的模型：${GEMINI_MODEL_NAME}\n官方錯誤訊息：${errorData}`
                }));
                // 延遲關閉，確保前端能收到訊息
                setTimeout(() => clientWs.close(1008, "Google API Rejected"), 500);
            }
        });
    });

    geminiWs.on('open', () => {
        console.log('已成功連上 Gemini Live API');
        isGeminiReady = true;

        // 發送初始化配置訊息
        const configMessage = {
            config: {
                model: GEMINI_MODEL_NAME,
                responseModalities: ["TEXT"],
                systemInstruction: {
                    parts: [{ text: "你是一個即時聽寫與翻譯助理。請仔細聆聽使用者的語音（可能是粵語或普通話）。每次使用者說完一段話停頓時，請你嚴格按照以下格式輸出：\n[原音逐字稿]\n|||\n[規範現代漢語翻譯]\n\n請務必使用 ||| 作為分隔符。絕對不要有任何問候語、解釋或其他廢話。" }]
                }
            }
        };
        geminiWs.send(JSON.stringify(configMessage));

        while(messageQueue.length > 0) {
            geminiWs.send(messageQueue.shift());
        }
    });

    geminiWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data.toString());
        }
    });

    geminiWs.on('close', (code, reason) => {
        console.log(`Gemini WS 關閉 - Code: ${code}, Reason: ${reason}`);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(code, reason.toString());
        }
    });

    geminiWs.on('error', (err) => {
        console.error('Gemini WS 發生錯誤:', err);
    });

    clientWs.on('message', (data) => {
        try {
            let msgStr = data.toString();
            let msgObj = JSON.parse(msgStr);

            // 轉換前端訊息格式為 Gemini Live API 格式
            if (msgObj.setup) {
                // 前端發送的 setup 訊息已被我們在 geminiWs.on('open') 中處理
                // 這裡可以忽略或處理其他配置
                return;
            }

            if (msgObj.realtimeInput && msgObj.realtimeInput.mediaChunks) {
                // 轉換 mediaChunks 為 audio 格式
                const chunk = msgObj.realtimeInput.mediaChunks[0];
                if (chunk) {
                    msgObj = {
                        realtimeInput: {
                            audio: {
                                data: chunk.data,
                                mimeType: chunk.mimeType
                            }
                        }
                    };
                    msgStr = JSON.stringify(msgObj);
                }
            }

            if (msgObj.clientContent && msgObj.clientContent.turnComplete) {
                // 轉發 turnComplete 訊息
                msgStr = JSON.stringify(msgObj);
            }

            if (isGeminiReady) {
                geminiWs.send(msgStr);
            } else {
                messageQueue.push(msgStr);
            }
        } catch (e) {
            console.error('處理客戶端訊息時發生錯誤:', e);
            if (isGeminiReady) geminiWs.send(data);
            else messageQueue.push(data);
        }
    });

    clientWs.on('close', () => {
        console.log('前端客戶端已斷線');
        if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});