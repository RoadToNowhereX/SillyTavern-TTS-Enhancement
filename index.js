/**
 * OpenAI Compatible Enhancement — SillyTavern 第三方 TTS 供应商扩展
 *
 * 所有合成都经酒馆服务器中转（relay），由服务器请求 OpenAI 兼容的
 * /v1/audio/speech 接口，浏览器不再直连供应商。
 *
 * 播放方式：
 *   整段播放（推荐）—— 中转接口返回单个完整音频，只播一次，完全连贯。
 *   分段流水线 —— 长文本自动按句切分、逐批请求、边到边播，首音更快。
 *
 * 安装位置：data/<user>/extensions/（在 git 之外，升级酒馆不受影响）
 */

import { getRequestHeaders, eventSource, event_types } from '../../../../script.js';
import { registerTtsProvider, saveTtsProviderSettings } from '../../tts/index.js';

const VERSION = '2.0.0';
const PROVIDER_NAME = 'OpenAI Compatible Enhancement';
const ST_RELAY_ROUTE = '/api/openai/custom/generate-voice';
const MODEL_PRESET = 'mimo-v2.5-tts';
const PREVIEW_TEXT = '你好，我是语音合成，这是一段试听。';

// ----------------------------------------------------------------------
//  在途请求的取消（重要）
//  酒馆的 resetTtsPlayback() 只会清空队列，**不会通知供应商取消已发出的请求**。
//  而整段合成要等供应商返回完整音频，若不取消，"过期"的音频会在用户切换消息之后才
//  落地播放 —— 表现为：点了另一条没反应 / 两条一起读 / 播起来没完。
//  这里采用「新的覆盖旧的」策略：新请求一来就中止上一个。
// ----------------------------------------------------------------------

/** @type {AbortController|null} */
let activeController = null;

function isAbortError(error) {
    return !!error && (error.name === 'AbortError' || /aborted|abort/i.test(String(error.message || '')));
}

/**
 * 判断清洗后的文本是否「有可朗读的内容」。
 * 中转接口对空串 / 纯换行 / 纯标点可能直接返回 HTTP 500，必须提前拦下来，
 * 否则用户看到的就是一坨 {"error":{"code":"500"...}}。
 */
function hasSpeakableText(text) {
    const s = String(text ?? '').trim();
    if (!s) {
        return false;
    }
    // 去掉所有空白 / 标点 / 符号后还剩东西，才算可朗读
    return s.replace(/[\s\p{P}\p{S}]/gu, '').length > 0;
}

/** 开始一次生成：中止上一个在途请求，返回新的 signal */
function beginGeneration() {
    abortActiveGeneration();
    activeController = new AbortController();
    return activeController.signal;
}

/** 中止当前在途生成（停止播放 / 切换消息 / 卸载供应商时调用） */
function abortActiveGeneration() {
    if (activeController) {
        try {
            activeController.abort();
        } catch {
            /* ignore */
        }
        activeController = null;
    }
}

function toast(kind, message) {
    try {
        if (typeof toastr !== 'undefined' && typeof toastr[kind] === 'function') {
            toastr[kind](message, PROVIDER_NAME, { timeOut: 3500 });
            return;
        }
    } catch {
        /* ignore */
    }
    console.info(`[${PROVIDER_NAME}] ${message}`);
}

export class MiMoTtsProvider {
    settings;
    voices = [];
    separator = '。';

    audioElement = document.createElement('audio');

    defaultSettings = {
        voiceMap: {},
        api_key: '',
        model: MODEL_PRESET,
        // 分段流水线：长文本自动按句切分、逐批请求、边到边播（首音更快）。
        // 用于替代酒馆的「按段朗读」——后者会让清洗变为逐行，跨行正则失效。
        pipeline: true,
        pipeline_first: 20,   // 首批字数（越小首音越快）
        pipeline_max: 120,    // 后续每批上限（越大卡顿越少）
        style: '',
        voices: ['茉莉', '冰糖', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'],
        // 中转地址留空，由用户自己填（不再写死某台机器的内网地址）
        relay_endpoint: '',
    };

    get settingsHtml() {
        return `
        <div class="mimo-tts-settings">
            <label for="mimo_relay_endpoint">中转地址（必填，由服务器发起请求）：</label>
            <input id="mimo_relay_endpoint" type="text" class="text_pole" maxlength="500" placeholder="例如 http://127.0.0.1:8000/v1/audio/speech"/>

            <label for="mimo_api_key">API Key（可选，随中转请求发送）：</label>
            <input id="mimo_api_key" type="password" class="text_pole" maxlength="200" placeholder="sk-..." autocomplete="off"/>

            <label for="mimo_model">模型：</label>
            <input id="mimo_model" type="text" class="text_pole" maxlength="100"/>

            <label for="mimo_voices">音色列表（逗号分隔）：</label>
            <input id="mimo_voices" type="text" class="text_pole" maxlength="500"/>

            <label for="mimo_style">风格指令（可留空）：</label>
            <input id="mimo_style" type="text" class="text_pole" maxlength="500" placeholder="例如：用轻快上扬的语调，语速稍快"/>

            <hr>

            <label class="checkbox_label">
                <input type="checkbox" id="mimo_pipeline"/>
                <span>分段流水线（长文本自动分句，首音更快）</span>
            </label>
            <small>
                酒馆的「按段朗读」会让文本清洗变成<b>逐行</b>执行，跨行正则因此失效
                （标签、元数据会被念出来）。要正确过滤，需把「按段朗读」<b>关掉</b>；
                关掉后由本扩展自己把长文本按句切分、逐批请求、边到边播，首音仍只要 1~2 秒。
            </small>

            <label for="mimo_pipeline_first">首批字数 / 后续每批上限：</label>
            <div class="flex-container alignItemsCenter flexGap5">
                <input id="mimo_pipeline_first" type="number" class="text_pole" min="5" max="200" step="5"/>
                <input id="mimo_pipeline_max" type="number" class="text_pole" min="20" max="500" step="10"/>
            </div>

            <small class="mimo-hint">
                所有合成请求都由酒馆服务器转发到上面的「中转地址」，浏览器不再直连供应商。<br>
                音色与角色映射沿用酒馆的 Voice Map，无需在此重复设置。
            </small>
            <div id="mimo_save_state" class="mimo-save-state" style="margin-top:6px;font-size:12px;opacity:.65"></div>
        </div>`;
    }

    dispose() {
        // 供应商被卸载/切换时，中止仍在途的生成，避免音频迟到落地
        abortActiveGeneration();
    }

    async loadSettings(settings) {
        this.settings = Object.assign({}, this.defaultSettings);
        this.settings.voiceMap = Object.assign({}, (settings && settings.voiceMap) || {});

        for (const key in settings) {
            if (key in this.defaultSettings && key !== 'voiceMap') {
                this.settings[key] = settings[key];
            } else if (!(key in this.defaultSettings)) {
                console.warn(`[TTS Enhancement] 忽略未知设置项: ${key}`);
            }
        }

        if (!Array.isArray(this.settings.voices)) {
            this.settings.voices = [...this.defaultSettings.voices];
        }

        $('#mimo_pipeline').prop('checked', !!this.settings.pipeline);
        $('#mimo_pipeline_first').val(this.settings.pipeline_first);
        $('#mimo_pipeline_max').val(this.settings.pipeline_max);
        $('#mimo_api_key').val(this.settings.api_key);
        $('#mimo_model').val(this.settings.model);
        $('#mimo_voices').val(this.settings.voices.join(','));
        $('#mimo_style').val(this.settings.style);
        $('#mimo_relay_endpoint').val(this.settings.relay_endpoint);

        const bind = (selector, handler) => {
            $(selector).off('input change').on('input change', handler);
        };

        bind('#mimo_pipeline', () => this.onSettingsChange());
        bind('#mimo_pipeline_first', () => this.onSettingsChange());
        bind('#mimo_pipeline_max', () => this.onSettingsChange());
        bind('#mimo_api_key', () => this.onSettingsChange());
        bind('#mimo_model', () => this.onSettingsChange());
        bind('#mimo_voices', () => this.onSettingsChange());
        bind('#mimo_style', () => this.onSettingsChange());
        bind('#mimo_relay_endpoint', () => this.onSettingsChange());

        await this.checkReady();

        console.info(`[${PROVIDER_NAME}] v${VERSION} 设置已加载`);
    }

    onSettingsChange() {
        this.settings.pipeline = !!$('#mimo_pipeline').prop('checked');
        const pf = Number($('#mimo_pipeline_first').val());
        this.settings.pipeline_first = Number.isFinite(pf) ? Math.min(200, Math.max(5, pf)) : 20;
        const pm = Number($('#mimo_pipeline_max').val());
        this.settings.pipeline_max = Number.isFinite(pm) ? Math.min(500, Math.max(20, pm)) : 120;
        this.settings.api_key = String($('#mimo_api_key').val() || '');
        this.settings.model = String($('#mimo_model').val() || MODEL_PRESET);
        this.settings.voices = String($('#mimo_voices').val() || '')
            .split(',')
            .map(v => v.trim())
            .filter(v => v.length > 0);
        this.settings.style = String($('#mimo_style').val() || '');
        this.settings.relay_endpoint = String($('#mimo_relay_endpoint').val() || '').trim();
        saveTtsProviderSettings();
        this.markSaved();
    }

    /** 让"到底存没存"这件事可见：酒馆是内存态整体回写 + 1s 防抖 */
    markSaved() {
        const el = document.getElementById('mimo_save_state');
        if (!el) {
            return;
        }
        const now = new Date();
        el.textContent = `设置已保存 ${now.toLocaleTimeString('zh-CN', { hour12: false })}（酒馆防抖 1 秒）`;
    }

    async checkReady() {
        this.voices = await this.fetchTtsVoiceObjects();
    }

    async onRefreshClick() {
        this.voices = await this.fetchTtsVoiceObjects();
    }

    async getVoice(voiceName) {
        if (this.voices.length === 0) {
            this.voices = await this.fetchTtsVoiceObjects();
        }
        const match = this.voices.find(v => v.name === voiceName || v.voice_id === voiceName);
        if (!match) {
            throw `TTS Voice name ${voiceName} not found`;
        }
        return match;
    }

    async fetchTtsVoiceObjects() {
        return (this.settings.voices || []).map(v => ({ name: v, voice_id: v, lang: 'zh-CN' }));
    }

    /** 酒馆的 voicemap 里存的是显示名，generateTts 收到的是 voice_id —— 两种都接住 */
    resolveVoiceId(input) {
        const raw = String(input ?? '').trim();
        if (!raw) {
            return raw;
        }
        const match = this.voices.find(v => v.name === raw || v.voice_id === raw);
        return match ? match.voice_id : raw;
    }

    // ------------------------------------------------------------------
    //  合成入口
    // ------------------------------------------------------------------

    generateTts(text, voiceId) {
        // 【防护】白名单式正则可能把「整条都是元数据块」的消息删空
        // （例如整条只有 <phone_module> 或 <chat_history>），
        // 而中转接口对空内容会返回 HTTP 500 —— 这里提前拦下，别把 500 抛给用户。
        if (!hasSpeakableText(text)) {
            console.info(`[${PROVIDER_NAME}] 这条消息清洗后没有可朗读的文字（可能整条都是元数据块），已跳过。清洗后内容:`, JSON.stringify(text));
            toast('info', '这条消息没有可朗读的文字（内容都是元数据块）');
            return (async function* () {})();
        }

        const resolved = this.resolveVoiceId(voiceId);
        // 新请求覆盖旧请求：中止上一个仍在途的生成
        const signal = beginGeneration();

        return this.wholeTts(text, resolved, signal);
    }

    /**
     * 把长文本切成适合流水线的批次。
     * 首批小（首音快），之后按几何增长到上限——因为供应商的生成速度约为播放速度的
     * 2.5 倍（实测约 54ms/字 vs 约 135ms/字），只要下一批不超上一批的 ~2.5 倍，
     * 播放就不会"断粮"（断供）。
     */
    splitIntoChunks(text) {
        const first = Math.max(5, Number(this.settings.pipeline_first) || 20);
        const max = Math.max(first, Number(this.settings.pipeline_max) || 120);
        const sentences = String(text).match(/[^。！？!?…；;\n]+[。！？!?…；;]*/g) || [String(text)];

        const chunks = [];
        let cur = '';
        let limit = first;

        for (const s of sentences) {
            if (cur && cur.length + s.length > limit) {
                chunks.push(cur);
                cur = s;
                limit = Math.min(max, Math.max(limit * 2, first));
            } else {
                cur += s;
            }
        }
        if (cur) {
            chunks.push(cur);
        }
        return chunks;
    }

    /**
     * 整段播放：逐批请求、边到边抛。
     * 每批都是一整段完整音频（内容不切碎），所以不会出现"突突突"；
     * 批与批之间会有一次换源开销（0.3~0.5s），落在句子边界上。
     */
    async *wholeTts(text, voiceId, signal) {
        const chunks = this.settings.pipeline ? this.splitIntoChunks(text) : [text];

        for (let i = 0; i < chunks.length; i++) {
            if (signal?.aborted) {
                console.info('[TTS Enhancement] 生成已取消（用户切换了消息或停止了播放）');
                return;
            }

            if (!hasSpeakableText(chunks[i])) {
                console.info(`[TTS Enhancement] 第 ${i + 1} 批没有可朗读的内容，跳过`);
                continue;
            }

            let bytes;
            let contentType;
            try {
                ({ bytes, contentType } = await this.fetchWholeBytes(chunks[i], voiceId, signal));
            } catch (error) {
                if (signal?.aborted || isAbortError(error)) {
                    console.info('[TTS Enhancement] 生成已取消（用户切换了消息或停止了播放）');
                    return;
                }
                if (i === 0) {
                    throw error; // 首批失败：直接把错误暴露给用户
                }
                console.warn(`[TTS Enhancement] 第 ${i + 1} 批失败，跳过该批：`, error);
                continue;
            }

            yield new Response(bytes, {
                status: 200,
                headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.length) },
            });
        }
    }

    /**
     * 拿一整段音频，返回原始字节 + MIME。
     * 固定经酒馆服务器中转：由服务器请求 provider_endpoint（OpenAI 兼容的
     * /v1/audio/speech），并把 API Key 一并转发。
     */
    async fetchWholeBytes(text, voiceId, signal) {
        const endpoint = String(this.settings.relay_endpoint || '').trim();
        if (!endpoint) {
            throw new Error('中转地址是空的。请在供应商设置里填写中转地址（例如 http://127.0.0.1:8000/v1/audio/speech）。');
        }

        const payload = {
            provider_endpoint: endpoint,
            model: this.settings.model,
            input: text,
            voice: voiceId,
            response_format: 'mp3',
            speed: 1,
        };
        const key = String(this.settings.api_key || '').trim();
        if (key) {
            payload.api_key = key;
        }

        const response = await fetch(ST_RELAY_ROUTE, {
            method: 'POST',
            headers: getRequestHeaders(),
            signal,
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            throw new Error(`中转失败 HTTP ${response.status}: ${await response.text()}`);
        }
        const buf = await response.arrayBuffer();
        if (buf.byteLength === 0) {
            throw new Error('中转返回了空音频，请检查服务器上的代理是否在运行');
        }
        return {
            bytes: new Uint8Array(buf),
            contentType: response.headers.get('Content-Type') || 'audio/mpeg',
        };
    }

    async previewTtsVoice(voiceId) {
        const resolved = this.resolveVoiceId(voiceId);
        this.audioElement.pause();
        this.audioElement.currentTime = 0;

        const { bytes, contentType } = await this.fetchWholeBytes(PREVIEW_TEXT, resolved);
        const audio = new Blob([bytes], { type: contentType });
        const url = URL.createObjectURL(audio);
        this.audioElement.src = url;
        this.audioElement.play();
        this.audioElement.onended = () => URL.revokeObjectURL(url);
    }
}

// ----------------------------------------------------------------------
//  注册供应商（下拉框里多一项 OpenAI Compatible Enhancement）
// ----------------------------------------------------------------------

let registered = false;

function ensureOption() {
    const select = document.getElementById('tts_provider');
    if (!select) {
        return;
    }
    const existing = select.querySelectorAll(`option[value="${PROVIDER_NAME}"]`);
    if (existing.length === 0) {
        const option = document.createElement('option');
        option.value = PROVIDER_NAME;
        option.textContent = PROVIDER_NAME;
        select.appendChild(option);
    } else {
        // 框架可能也追加过一次，去重
        for (let i = 1; i < existing.length; i++) {
            existing[i].remove();
        }
    }
}

export function init() {
    register();
}

function register() {
    scheduleUi();
    if (registered) {
        return;
    }
    try {
        registerTtsProvider(PROVIDER_NAME, MiMoTtsProvider);
        registered = true;
        console.info(`[TTS Enhancement] v${VERSION} 供应商已注册`);
    } catch (error) {
        console.warn('[TTS Enhancement] 注册失败（可能已注册）', error);
    }
}

function scheduleUi() {
    ensureOption();
    for (const ms of [0, 500, 1500, 3000]) {
        setTimeout(ensureOption, ms);
    }
    try {
        if (eventSource && event_types && event_types.APP_READY) {
            eventSource.on(event_types.APP_READY, ensureOption);
        }
    } catch {
        /* ignore */
    }
}

register();
