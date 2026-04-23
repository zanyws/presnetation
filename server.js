const express = require('express');
const cors = require('cors');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.error("警告：未設定 GEMINI_API_KEY 環境變數！");
}

// API 端點 - 處理帶文章參考的轉譯和摘要
app.post('/api/process-text', async (req, res) => {
    try {
        const { text, articleTitle, articleContent, mode } = req.body;

        if (!text || !text.trim()) {
            return res.status(400).json({ error: '請提供要處理的文字' });
        }

        // 使用支援 generateContent 的穩定模型
        const modelId = 'gemini-2.0-flash-exp';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`;

        let prompt = '';

        if (mode === 'translate') {
            // 書面語轉譯模式
            prompt = `請將以下學生口語內容轉換為正式的書面語，並修正任何語音辨識錯誤：

原始內容：${text}

${articleTitle ? `參考文章標題：${articleTitle}` : ''}
${articleContent ? `參考文章內容：${articleContent}` : ''}

請根據${articleTitle || articleContent ? '參考內容' : '一般語境'}修正可能的語音辨識錯誤，輸出正式的書面語版本。`;
        } else if (mode === 'summary') {
            // 摘要模式
            prompt = `請為以下學生匯報內容製作簡潔的摘要：

內容：${text}

${articleTitle ? `相關文章標題：${articleTitle}` : ''}
${articleContent ? `參考文章內容：${articleContent}` : ''}

摘要要求：
- 抓住重點，簡潔有力
- 包含主要觀點和結論
- 長度控制在 50-100 字以內`;
        }

        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            systemInstruction: {
                parts: [{
                    text: "你是一個專業的教育助理，專門處理學生語音摘錄的轉譯和摘要工作。請確保輸出準確、專業且符合教育需求。"
                }]
            }
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
        console.error('文字處理 API 錯誤:', error);
        res.status(500).json({ error: error.message });
    }
});

// 測試端點：檢查可用模型
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

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});