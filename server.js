const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const cors = require('cors');
const http = require('http');

const app = express();

// 允許跨網域請求 (讓 Cloudflare 的前端能連線過來)
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 從環境變數讀取配置 (在 Render 後台設定)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// 若未設定模型，預設使用支援 Live API 的 exp 模型
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || 'models/gemini-2.0-flash-exp';

if (!GEMINI_API_KEY) {
    console.error("警告：未設定 GEMINI_API_KEY 環境變數！");
}

// 1. REST API 端點：處理摘要生成請求
app.post('/api/summary', async (req, res) => {
    try {
        const { prompt } = req.body;
        // 確保模型 ID 格式正確
        const modelId = GEMINI_MODEL_NAME.replace('models/', '');
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`;

        // 構建請求內容
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

// 建立 HTTP 伺服器
const server = http.createServer(app);

// 2. WebSocket 伺服器：負責代理前端音訊流到 Gemini Live API
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
    console.log('前端客戶端已連線，準備代理至 Gemini...');

    if (!GEMINI_API_KEY) {
        clientWs.close(1011, "後端未設定 API Key");
        return;
    }

    // 建立與 Google Gemini 的連線
    const geminiWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    const geminiWs = new WebSocket(geminiWsUrl);

    let isGeminiReady = false;
    const messageQueue = [];

    // 當成功連上 Gemini
    geminiWs.on('open', () => {
        console.log('已成功連上 Gemini Live API');
        isGeminiReady = true;
        // 將前端稍早傳送且被佇列的訊息(如 Setup)全部送出
        while(messageQueue.length > 0) {
            geminiWs.send(messageQueue.shift());
        }
    });

    // 收到 Gemini 的回覆 -> 轉發給前端
    geminiWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data.toString());
        }
    });

    geminiWs.on('close', () => {
        console.log('Gemini WS 連線已關閉');
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });

    geminiWs.on('error', (err) => {
        console.error('Gemini WS 發生錯誤:', err);
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });

    // 收到前端的訊息 -> 轉發給 Gemini
    clientWs.on('message', (data) => {
        try {
            let msgStr = data.toString();
            let msgObj = JSON.parse(msgStr);

            // 核心邏輯：攔截前端傳來的 setup 訊息，並在後端強制注入模型名稱
            if (msgObj.setup) {
                msgObj.setup.model = GEMINI_MODEL_NAME;
                msgStr = JSON.stringify(msgObj);
            }

            if (isGeminiReady) {
                geminiWs.send(msgStr);
            } else {
                // 若 Gemini 還沒連上，先放入佇列
                messageQueue.push(msgStr);
            }
        } catch (e) {
            // 如果是非 JSON 格式（或解析錯誤），直接轉發
            if (isGeminiReady) {
                geminiWs.send(data);
            } else {
                messageQueue.push(data);
            }
        }
    });

    clientWs.on('close', () => {
        console.log('前端客戶端已斷線');
        if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    });
});

// 啟動伺服器
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
