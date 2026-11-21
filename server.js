const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const CryptoJS = require('crypto-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 常見 AES 金鑰庫（純加解密演算工具，無特定版權資料）
const KNOWN_KEYS = [
    { key: '1234567890123456', iv: '1234567890123456' },
    { key: '2023061618181818', iv: '2023061618181818' },
    { key: '0123456789abcdef', iv: '0123456789abcdef' },
    { key: 'feimao2023080808', iv: 'feimao2023080808' },
    { key: 'fantaiying666666', iv: 'fantaiying666666' }
];

function tryDecryptConfig(rawStr) {
    if (typeof rawStr !== 'string') return rawStr;
    let cleanStr = rawStr.trim();
    if (cleanStr.startsWith('{') && cleanStr.endsWith('}')) {
        try { return JSON.parse(cleanStr); } catch (e) {}
    }
    try {
        const decoded = Buffer.from(cleanStr, 'base64').toString('utf-8');
        if (decoded.trim().startsWith('{')) return JSON.parse(decoded.trim());
    } catch (e) {}
    for (const item of KNOWN_KEYS) {
        try {
            const key = CryptoJS.enc.Utf8.parse(item.key);
            const iv = CryptoJS.enc.Utf8.parse(item.iv);
            const decrypted = CryptoJS.AES.decrypt(cleanStr, key, {
                iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7
            }).toString(CryptoJS.enc.Utf8);
            if (decrypted && decrypted.trim().startsWith('{')) return JSON.parse(decrypted.trim());
        } catch (e) {}
    }
    return null;
}

// 解析使用者本機上傳的自訂設定檔
app.post('/api/parse-custom-config', (req, res) => {
    const { rawContent } = req.body;
    if (!rawContent) return res.status(400).json({ error: '檔案內容為空' });

    let configObj = tryDecryptConfig(rawContent);
    if (!configObj || typeof configObj !== 'object') {
        return res.status(400).json({ error: '無法解析該設定檔' });
    }

    if (Array.isArray(configObj.urls)) {
        return res.json({ type: 'urls', list: configObj.urls, sites: configObj.sites || [] });
    }
    if (Array.isArray(configObj.sites)) {
        return res.json({ type: 'sites', list: configObj.sites });
    }

    res.json({ type: 'unknown', data: configObj });
});

// 遠端連線代理：純轉發解析使用者指定的遠端訂閱
app.get('/api/fetch-config', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('缺少 url 參數');

    try {
        targetUrl = encodeURI(targetUrl);
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'okhttp/3.15.0', 'Accept': '*/*' },
            timeout: 8000,
            responseType: 'text'
        });
        let configObj = tryDecryptConfig(response.data);
        if (!configObj || typeof configObj !== 'object' || !Array.isArray(configObj.sites)) {
            return res.json({ sites: [], errorMsg: '該遠端線路未回傳標準站點或解析受限' });
        }
        res.json({ sites: configObj.sites, fromRemote: true });
    } catch (err) {
        res.json({ sites: [], errorMsg: `遠端連線失敗: ${err.message}` });
    }
});

// 標準 CMS 影視資料代理
app.get('/api/cms/list', async (req, res) => {
    const { api, pg, t, wd, ac } = req.query;
    if (!api) return res.status(400).send('缺少 api');

    try {
        const separator = api.includes('?') ? '&' : '?';
        let queryParams = ac ? `ac=${ac}` : 'ac=detail';
        if (wd) queryParams += `&wd=${encodeURIComponent(wd)}`;
        if (t) queryParams += `&t=${encodeURIComponent(t)}`;
        queryParams += `&pg=${pg ? pg : '1'}`;
        const url = `${api}${separator}${queryParams}`;

        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 12000
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: `獲取片源失敗: ${err.message}` });
    }
});

// 串流 m3u8 代理（解決瀏覽器 CORS 跨域限制）
app.get('/api/proxy-m3u8', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('缺少 url 參數');

    try {
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': targetUrl
            },
            responseType: 'text',
            timeout: 15000
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');

        const lines = response.data.split('\n');
        const rewritten = lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;

            const absoluteUrl = new URL(trimmed, targetUrl).href;
            if (trimmed.endsWith('.m3u8') || trimmed.includes('.m3u8?')) {
                return `/api/proxy-m3u8?url=${encodeURIComponent(absoluteUrl)}`;
            }
            return `/api/proxy-ts?url=${encodeURIComponent(absoluteUrl)}`;
        }).join('\n');

        res.send(rewritten);
    } catch (err) {
        res.status(502).send(`代理 m3u8 失敗: ${err.message}`);
    }
});

// 串流 ts 切片轉發代理
app.get('/api/proxy-ts', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('缺少 url 參數');

    try {
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': targetUrl
            },
            responseType: 'stream',
            timeout: 20000
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', response.headers['content-type'] || 'video/MP2T');
        response.data.pipe(res);
    } catch (err) {
        res.status(502).send(`代理切片失敗: ${err.message}`);
    }
});

app.listen(PORT, () => {
    console.log(`伺服器已啟動：http://localhost:${PORT}`);
});