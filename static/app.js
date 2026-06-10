document.addEventListener('DOMContentLoaded', function () {
    const socket = io();
    const DEFAULT_PROMPT = "参考下面的翻译：\n{terms}\n\n将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n{text}";

    // ============ localStorage ============
    const STORAGE_KEY = 'whisper_hy_config';
    function loadLocalConfig() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch(e) { return {}; } }
    function saveLocalConfig(patch) { const c = loadLocalConfig(); Object.assign(c, patch); localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); }
    function getLocalVal(key, fb) { return loadLocalConfig()[key] || fb || ''; }

    // ============ DOM ============
    const el = (id) => document.getElementById(id);
    const consoleEl = el('console'), progressBar = el('progress-bar'), progressWrap = el('progress-wrap'), progressText = el('progress-text');
    const whisperSelect = el('whisperModelSelect'), audioFileInput = el('audioFile'), jsonFileInput = el('jsonFile');
    const previewTbody = el('preview-tbody'), tableStats = el('table-stats');
    
    // 修复：正确获取DOM元素，避免变量名冲突
    const sfApiKeyInput = el('sfApiKey');
    const sfModelSelect = el('sfModel');  // HTML中id是"sfModel"
    const cfgWhisperPath = el('cfg-whisperPath'), cfgHyPath = el('cfg-hyPath');
    const langSelect = el('setting-language'), modeHint = el('translate-mode-hint');
    const buttons = { asr: el('btn-asr'), translateJson: el('btn-translate-json') };

    // 自定义模型相关元素
    const sfModelCustom = el('sfModelCustom');
    const customModelArea = el('custom-model-area');
    const btnShowCustomModel = el('btn-show-custom-model');
    const btnUseCustomModel = el('btn-use-custom-model');

    // ============ State ============
    let taskFinished = true;
    let tableData = { original: [], translated: [] };
    let currentModels = [];
    let currentModelSource = 'select';
    let customModelValue = '';

    // ============ Utils ============
    const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const logToConsole = (msg, type) => {
        const time = new Date().toLocaleTimeString();
        const icons = { info: 'info-circle text-info', success: 'check-circle text-success', error: 'exclamation-triangle text-danger', io: 'reception-4 text-primary' };
        const cls = icons[type] || icons.info;
        consoleEl.innerHTML += '<div><small class="text-muted me-2">' + time + '</small><i class="bi bi-' + cls + '"></i> ' + msg + '</div>';
        consoleEl.scrollTop = consoleEl.scrollHeight;
    };

    const setProgress = (value, text) => {
        progressWrap.style.display = 'block';
        progressBar.classList.add('progress-bar-animated', 'progress-bar-striped');
        progressBar.style.width = value + '%';
        progressBar.classList.remove('bg-success', 'bg-danger');
        if (value === 100) {
            progressBar.classList.add('bg-success');
            progressBar.classList.remove('progress-bar-animated', 'progress-bar-striped');
            setTimeout(function() { progressWrap.style.display = 'none'; progressText.textContent = ''; setProgress(0, ''); }, 3000);
        }
        progressText.textContent = text || '';
    };

    const failProgress = (text) => {
        progressBar.style.width = '100%';
        progressBar.classList.add('bg-danger');
        progressBar.classList.remove('progress-bar-animated', 'progress-bar-striped');
        progressText.textContent = text || '任务失败';
        toggleButtons(true);
    };

    const toggleButtons = (enable) => { Object.values(buttons).forEach(b => { if (b) b.disabled = !enable; }); };

    const renderTable = () => {
        const orig = tableData.original, trans = tableData.translated;
        const len = Math.max(orig.length, trans.length);
        if (!len) { previewTbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-5">暂无数据</td></tr>'; tableStats.textContent = ''; return; }
        let html = '';
        for (let i = 0; i < len; i++) {
            const o = orig[i] || {}, t = trans[i] || {};
            const time = o.start ? (o.start + '<br><small class="text-muted">' + o.end + '</small>') : '';
            const ot = o.text ? escHtml(o.text) : '<span class="text-muted">—</span>';
            const tt = t.text ? escHtml(t.text) : '<span class="text-muted">—</span>';
            html += '<tr><td class="text-muted">' + (i+1) + '</td><td style="font-size:.78rem">' + time + '</td><td>' + ot + '</td><td>' + tt + '</td></tr>';
        }
        previewTbody.innerHTML = html;
        tableStats.textContent = orig.length + ' 条原文 / ' + trans.length + ' 条译文';
    };

    function updateTranslateModeUI(mode) {
        if (modeHint) modeHint.textContent = mode === 'api' ? '使用硅基流动 API 在线翻译' : '使用本地混元模型翻译';
    }

    // ============ 硅基流动模型管理 ============
    function refreshSiliconFlowModels() {
        const apiKey = sfApiKeyInput ? sfApiKeyInput.value.trim() : '';
        if (!apiKey) {
            const hint = el('sf-model-hint');
            if (hint) hint.innerHTML = '<span class="text-warning">⚠️ 请先填写 API Key 并点击保存</span>';
            loadPresetModels();
            return;
        }
        
        if (sfModelSelect) {
            // 保留自定义模型选项
            const customOptions = [];
            for (let i = sfModelSelect.options.length - 1; i >= 0; i--) {
                if (sfModelSelect.options[i].getAttribute && sfModelSelect.options[i].getAttribute('data-custom') === 'true') {
                    customOptions.push(sfModelSelect.options[i]);
                }
            }
            while (sfModelSelect.options.length > 0) sfModelSelect.remove(0);
            customOptions.forEach(opt => sfModelSelect.add(opt));
            
            if (sfModelSelect.options.length === 0) {
                sfModelSelect.innerHTML = '<option value="">正在获取模型列表...</option>';
            }
        }
        
        const hint = el('sf-model-hint');
        if (hint) hint.innerHTML = '<span class="text-info"><i class="bi bi-arrow-repeat me-1"></i>正在获取模型列表，请稍候...</span>';
        
        socket.emit('refresh_siliconflow_models', { api_key: apiKey });
    }

    function updateModelSelect(models) {
        if (!sfModelSelect) return;
        
        currentModels = models;
        
        // 保存自定义选项
        let customOption = null;
        for (let i = 0; i < sfModelSelect.options.length; i++) {
            if (sfModelSelect.options[i].getAttribute && sfModelSelect.options[i].getAttribute('data-custom') === 'true') {
                customOption = sfModelSelect.options[i];
                break;
            }
        }
        
        sfModelSelect.innerHTML = '';
        
        if (!models || models.length === 0) {
            sfModelSelect.innerHTML = '<option value="">暂无可用模型</option>';
            const hint = el('sf-model-hint');
            if (hint) hint.innerHTML = '<span class="text-warning">未获取到模型列表，请检查 API Key</span>';
            return;
        }
        
        // 分组显示
        const hunyuanModels = models.filter(m => m.id.toLowerCase().includes('hunyuan'));
        const qwenModels = models.filter(m => m.id.toLowerCase().includes('qwen'));
        const deepseekModels = models.filter(m => m.id.toLowerCase().includes('deepseek'));
        const llamaModels = models.filter(m => m.id.toLowerCase().includes('llama'));
        const otherModels = models.filter(m => 
            !m.id.toLowerCase().includes('hunyuan') && 
            !m.id.toLowerCase().includes('qwen') &&
            !m.id.toLowerCase().includes('deepseek') &&
            !m.id.toLowerCase().includes('llama')
        );
        
        if (hunyuanModels.length > 0) {
            const group = document.createElement('optgroup');
            group.label = '🔥 混元模型 (推荐优先)';
            hunyuanModels.forEach(model => {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name || model.id;
                if (model.description) option.title = model.description;
                group.appendChild(option);
            });
            sfModelSelect.appendChild(group);
        }
        
        if (qwenModels.length > 0) {
            const group = document.createElement('optgroup');
            group.label = '✨ 通义千问模型';
            qwenModels.forEach(model => {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name || model.id;
                group.appendChild(option);
            });
            sfModelSelect.appendChild(group);
        }
        
        if (deepseekModels.length > 0) {
            const group = document.createElement('optgroup');
            group.label = '🚀 DeepSeek 模型';
            deepseekModels.forEach(model => {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name || model.id;
                group.appendChild(option);
            });
            sfModelSelect.appendChild(group);
        }
        
        if (llamaModels.length > 0) {
            const group = document.createElement('optgroup');
            group.label = '🦙 Llama 模型';
            llamaModels.forEach(model => {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name || model.id;
                group.appendChild(option);
            });
            sfModelSelect.appendChild(group);
        }
        
        if (otherModels.length > 0) {
            const group = document.createElement('optgroup');
            group.label = '📦 其他模型';
            otherModels.forEach(model => {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name || model.id;
                group.appendChild(option);
            });
            sfModelSelect.appendChild(group);
        }
        
        // 恢复自定义选项
        if (customOption) {
            sfModelSelect.add(customOption, 0);
            customOption.selected = true;
        }
        
        const hint = el('sf-model-hint');
        if (hint) hint.innerHTML = `<span class="text-success">✅ 共获取 ${models.length} 个可用模型，混元模型已优先排序</span>`;
        
        // 尝试恢复之前保存的模型选择
        const savedModel = getLocalVal('siliconflow_model');
        const modelSource = getLocalVal('siliconflow_model_source', 'select');
        
        if (modelSource !== 'custom' && savedModel) {
            for (let i = 0; i < sfModelSelect.options.length; i++) {
                if (sfModelSelect.options[i].value === savedModel) {
                    sfModelSelect.selectedIndex = i;
                    break;
                }
            }
        }
    }

    function loadPresetModels() {
        fetch('/get_preset_models')
            .then(res => res.json())
            .then(data => {
                if (data.models && data.models.length > 0) {
                    updateModelSelect(data.models);
                    const hint = el('sf-model-hint');
                    if (hint) hint.innerHTML = '<span class="text-warning">⚠️ 使用预设模型列表，请配置 API Key 获取最新模型</span>';
                }
            })
            .catch(err => {
                console.error('加载预设模型失败:', err);
                const hint = el('sf-model-hint');
                if (hint) hint.innerHTML = '<span class="text-danger">加载模型列表失败</span>';
            });
    }

    // ============ 获取配置 ============
    function getConfig() {
        let siliconflow_model = '';
        const modelSource = getLocalVal('siliconflow_model_source', 'select');
        
        if (modelSource === 'custom') {
            siliconflow_model = getLocalVal('siliconflow_model_custom') || getLocalVal('siliconflow_model');
        } else if (sfModelSelect && sfModelSelect.value) {
            siliconflow_model = sfModelSelect.value;
        } else {
            siliconflow_model = getLocalVal('siliconflow_model', 'Tencent-Hunyuan/Hunyuan-2.0-Instruct');
        }
        
        // 如果是自定义选项，从属性获取
        if (sfModelSelect && sfModelSelect.selectedOptions[0]) {
            const selected = sfModelSelect.selectedOptions[0];
            if (selected.getAttribute && selected.getAttribute('data-custom') === 'true') {
                siliconflow_model = selected.value;
            }
        }
        
        return {
            whisper_path: whisperSelect ? (whisperSelect.value || getLocalVal('whisper_path')) : getLocalVal('whisper_path'),
            hy_path: cfgHyPath ? (cfgHyPath.value || getLocalVal('hy_path')) : getLocalVal('hy_path'),
            audio_file: audioFileInput ? audioFileInput.value : '',
            language: langSelect ? (langSelect.value || 'pt') : 'pt',
            whisper_device: (document.querySelector('input[name="whisperDevice"]:checked') || {}).value || 'cuda',
            translate_mode: (document.querySelector('input[name="translateMode"]:checked') || {}).value || 'local',
            siliconflow_api_key: sfApiKeyInput ? (sfApiKeyInput.value || getLocalVal('siliconflow_api_key')) : '',
            siliconflow_model: siliconflow_model,
        };
    }

    function restoreFromLocal() {
        const cfg = loadLocalConfig();
        
        console.log('[DEBUG] Loading local config:', cfg);
        
        if (cfg.whisper_path && cfgWhisperPath) cfgWhisperPath.value = cfg.whisper_path;
        if (cfg.hy_path && cfgHyPath) cfgHyPath.value = cfg.hy_path;
        if (cfg.language && langSelect) langSelect.value = cfg.language;
        
        if (cfg.whisper_device) { 
            const r = document.querySelector('input[name="whisperDevice"][value="' + cfg.whisper_device + '"]'); 
            if (r) r.checked = true; 
        }
        
        if (cfg.translate_mode) { 
            const r = document.querySelector('input[name="translateMode"][value="' + cfg.translate_mode + '"]'); 
            if (r) r.checked = true; 
        }
        updateTranslateModeUI(cfg.translate_mode || 'local');
        
        if (cfg.siliconflow_api_key && sfApiKeyInput) {
            sfApiKeyInput.value = cfg.siliconflow_api_key;
            console.log('[DEBUG] Restored API Key:', cfg.siliconflow_api_key.substring(0, 20) + '...');
        }
        
        // 恢复自定义模型
        const modelSource = cfg.siliconflow_model_source || 'select';
        const savedModel = cfg.siliconflow_model || '';
        
        if (modelSource === 'custom' && savedModel) {
            customModelValue = savedModel;
            currentModelSource = 'custom';
            if (sfModelCustom) sfModelCustom.value = savedModel;
            
            if (sfModelSelect && savedModel) {
                let exists = false;
                for (let i = 0; i < sfModelSelect.options.length; i++) {
                    if (sfModelSelect.options[i].getAttribute && sfModelSelect.options[i].getAttribute('data-custom') === 'true') {
                        exists = true;
                        sfModelSelect.options[i].value = savedModel;
                        sfModelSelect.options[i].textContent = `🔧 自定义: ${savedModel}`;
                        sfModelSelect.options[i].selected = true;
                        break;
                    }
                }
                if (!exists) {
                    const customOption = document.createElement('option');
                    customOption.value = savedModel;
                    customOption.textContent = `🔧 自定义: ${savedModel}`;
                    customOption.setAttribute('data-custom', 'true');
                    customOption.selected = true;
                    sfModelSelect.add(customOption, 0);
                }
            }
        } else if (savedModel && sfModelSelect) {
            window.pendingModelSelection = savedModel;
        }
        
        if (cfg.audio_file && audioFileInput) audioFileInput.value = cfg.audio_file;
        if (cfg.json_file && jsonFileInput) jsonFileInput.value = cfg.json_file;
    }

    // ============ Socket.IO ============
    socket.on('connect', function() { logToConsole('已连接到后端服务。', 'io'); socket.emit('get_initial_config'); });
    socket.on('disconnect', function() { logToConsole('与后端服务断开连接。', 'error'); if (!taskFinished) toggleButtons(false); });
    socket.on('reconnect', function() { logToConsole('已重新连接。', 'io'); if (taskFinished) toggleButtons(true); });

    socket.on('initial_config', function(cfg) {
        const local = loadLocalConfig();
        const wp = local.whisper_path || cfg.whisper_path || '';
        if (cfgWhisperPath) cfgWhisperPath.value = wp;
        const hp = local.hy_path || cfg.hy_path || '';
        if (cfgHyPath) cfgHyPath.value = hp;
        if (langSelect) langSelect.value = local.language || cfg.language || 'pt';
        if (cfg.terminology) renderTermTable(cfg.terminology);
        var promptEl = el('prompt-editor');
        if (promptEl) promptEl.value = cfg.prompt_template || DEFAULT_PROMPT;
        const dev = local.whisper_device || cfg.whisper_device || 'cuda';
        var devR = document.querySelector('input[name="whisperDevice"][value="' + dev + '"]');
        if (devR) devR.checked = true;
        const mode = local.translate_mode || cfg.translate_mode || 'local';
        var modeR = document.querySelector('input[name="translateMode"][value="' + mode + '"]');
        if (modeR) modeR.checked = true;
        updateTranslateModeUI(mode);
        if (sfApiKeyInput) sfApiKeyInput.value = local.siliconflow_api_key || cfg.siliconflow_api_key || '';
        
        const savedModel = local.siliconflow_model || cfg.siliconflow_model || 'Tencent-Hunyuan/Hunyuan-2.0-Instruct';
        const savedSource = local.siliconflow_model_source || cfg.siliconflow_model_source || 'select';
        
        if (savedSource === 'custom') {
            customModelValue = savedModel;
            currentModelSource = 'custom';
            if (sfModelCustom) sfModelCustom.value = savedModel;
        } else {
            window.pendingModelSelection = savedModel;
        }
        
        saveLocalConfig({ whisper_path: wp, hy_path: hp, language: langSelect.value, whisper_device: dev, translate_mode: mode, siliconflow_api_key: sfApiKeyInput.value, siliconflow_model: savedModel, siliconflow_model_source: savedSource });
        logToConsole('初始配置加载完毕。', 'success');
        refreshWhisperModels();
        
        if (sfApiKeyInput && sfApiKeyInput.value) {
            setTimeout(() => { refreshSiliconFlowModels(); }, 500);
        } else {
            loadPresetModels();
        }
    });

    socket.on('siliconflow_models_updated', function(data) {
        if (data.error) {
            console.error('获取模型失败:', data.error);
            const hint = el('sf-model-hint');
            if (hint) hint.innerHTML = `<span class="text-danger">❌ ${data.error}</span>`;
            if (data.preset && data.models && data.models.length > 0) {
                updateModelSelect(data.models);
            } else {
                loadPresetModels();
            }
        } else if (data.models && data.models.length > 0) {
            updateModelSelect(data.models);
            
            if (window.pendingModelSelection && sfModelSelect) {
                for (let i = 0; i < sfModelSelect.options.length; i++) {
                    if (sfModelSelect.options[i].value === window.pendingModelSelection) {
                        sfModelSelect.selectedIndex = i;
                        break;
                    }
                }
                delete window.pendingModelSelection;
            }
        } else {
            loadPresetModels();
        }
    });

    socket.on('model_verified', function(data) {
        if (data.available) {
            logToConsole(`✅ 模型 ${data.model} 验证通过，可以正常使用`, 'success');
        } else {
            logToConsole(`⚠️ 模型 ${data.model} 验证失败: ${data.error}`, 'warning');
        }
    });

    socket.on('log', function(d) { logToConsole(d.msg); });
    socket.on('progress', function(d) { setProgress(d.value, d.text); });
    socket.on('task_done', function(d) { taskFinished = true; logToConsole('<b>' + d.msg + '</b>', 'success'); setProgress(100, '完成'); toggleButtons(true); });
    socket.on('task_error', function(d) { taskFinished = true; logToConsole('<b>' + d.msg + '</b>', 'error'); failProgress('任务出错'); toggleButtons(true); });
    socket.on('file_preview', function(d) { if (d.type === 'original') tableData.original = d.content || []; if (d.type === 'translated') tableData.translated = d.content || []; renderTable(); });
    socket.on('settings_saved', function(d) { logToConsole('[设置] ' + d.msg, d.success ? 'success' : 'error'); });

    // ============ Tasks ============
    if (buttons.asr) {
        buttons.asr.addEventListener('click', function() {
            var cfg = getConfig();
            if (!cfg.whisper_path) { alert('请先设置 Whisper 模型路径（导航栏 → 模型路径 或下拉选择）'); return; }
            if (!cfg.audio_file) { alert('请先选择音频文件'); return; }
            taskFinished = false; tableData = { original: [], translated: [] }; renderTable(); setProgress(0, ''); toggleButtons(false);
            logToConsole('--- 开始语音识别任务 ---');
            socket.emit('start_task', Object.assign({ task: 'asr' }, cfg));
        });
    }

    if (buttons.translateJson) {
        buttons.translateJson.addEventListener('click', function() {
            var cfg = getConfig();
            var jsonPath = jsonFileInput ? jsonFileInput.value.trim() : '';
            if (!jsonPath) { alert('请先选择 JSON 文件'); return; }
            if (cfg.translate_mode !== 'api' && !cfg.hy_path) { alert('请先设置混元翻译模型路径（导航栏 → 模型路径）或切换为 API 模式'); return; }
            if (cfg.translate_mode === 'api' && !cfg.siliconflow_api_key) { alert('请先设置硅基流动 API Key（导航栏 → 硅基流动 API）'); return; }
            taskFinished = false; tableData.translated = []; renderTable(); setProgress(0, ''); toggleButtons(false);
            logToConsole('--- 开始翻译 JSON 字幕 ---');
            socket.emit('start_task', Object.assign({ task: 'translate_json', json_file: jsonPath }, cfg));
        });
    }

    // ============ Control Events ============
    document.querySelectorAll('input[name="whisperDevice"]').forEach(function(r) {
        r.addEventListener('change', function() { saveLocalConfig({ whisper_device: r.value }); socket.emit('save_settings', { whisper_device: r.value }); });
    });
    document.querySelectorAll('input[name="translateMode"]').forEach(function(r) {
        r.addEventListener('change', function() { saveLocalConfig({ translate_mode: r.value }); updateTranslateModeUI(r.value); socket.emit('save_settings', { translate_mode: r.value }); });
    });
    if (langSelect) langSelect.addEventListener('change', function() { saveLocalConfig({ language: langSelect.value }); socket.emit('save_settings', { language: langSelect.value }); });
    if (whisperSelect) whisperSelect.addEventListener('change', function() {
        var val = whisperSelect.value;
        if (val) { saveLocalConfig({ whisper_path: val }); if (cfgWhisperPath) cfgWhisperPath.value = val; socket.emit('save_config', { whisper_path: val, hy_path: cfgHyPath ? cfgHyPath.value : '' }); }
    });

    // ============ Modal: Model Paths ============
    const saveModelPathsBtn = el('btn-save-model-paths');
    if (saveModelPathsBtn) {
        saveModelPathsBtn.addEventListener('click', function() {
            var wp = cfgWhisperPath ? cfgWhisperPath.value.trim() : '';
            var hp = cfgHyPath ? cfgHyPath.value.trim() : '';
            saveLocalConfig({ whisper_path: wp, hy_path: hp });
            socket.emit('save_config', { whisper_path: wp, hy_path: hp });
            if (wp && whisperSelect) { for (var i = 0; i < whisperSelect.options.length; i++) { if (whisperSelect.options[i].value === wp) { whisperSelect.value = wp; break; } } }
            const modal = el('modelPathModal');
            if (modal && bootstrap.Modal) bootstrap.Modal.getInstance(modal).hide();
            logToConsole('模型路径已保存。', 'success');
        });
    }

    // ============ Modal: API ============
    const refreshModelsBtn = el('btn-refresh-models-api');
    if (refreshModelsBtn) {
        refreshModelsBtn.addEventListener('click', function() { refreshSiliconFlowModels(); });
    }

    // 显示/隐藏自定义模型输入区域
    if (btnShowCustomModel) {
        btnShowCustomModel.addEventListener('click', function() {
            if (customModelArea) {
                if (customModelArea.style.display === 'none') {
                    customModelArea.style.display = 'block';
                    btnShowCustomModel.innerHTML = '<i class="bi bi-x-circle me-1"></i>取消手动输入';
                    if (customModelValue && sfModelCustom) sfModelCustom.value = customModelValue;
                } else {
                    customModelArea.style.display = 'none';
                    btnShowCustomModel.innerHTML = '<i class="bi bi-pencil-square me-1"></i>手动输入';
                }
            }
        });
    }

    // 使用自定义模型
    if (btnUseCustomModel) {
        btnUseCustomModel.addEventListener('click', function() {
            const customModel = sfModelCustom ? sfModelCustom.value.trim() : '';
            if (!customModel) { alert('请输入模型 ID'); return; }
            
            currentModelSource = 'custom';
            customModelValue = customModel;
            
            if (sfModelSelect) {
                for (let i = 0; i < sfModelSelect.options.length; i++) {
                    if (sfModelSelect.options[i].getAttribute && sfModelSelect.options[i].getAttribute('data-custom') === 'true') {
                        sfModelSelect.remove(i);
                        break;
                    }
                }
                const customOption = document.createElement('option');
                customOption.value = customModel;
                customOption.textContent = `🔧 自定义: ${customModel}`;
                customOption.setAttribute('data-custom', 'true');
                customOption.selected = true;
                sfModelSelect.add(customOption, 0);
            }
            
            const hint = el('sf-model-hint');
            if (hint) hint.innerHTML = `<span class="text-info"><i class="bi bi-pencil-square me-1"></i>使用自定义模型: ${customModel}</span>`;
            
            saveLocalConfig({ siliconflow_model: customModel, siliconflow_model_source: 'custom', siliconflow_model_custom: customModel });
            
            if (customModelArea) customModelArea.style.display = 'none';
            if (btnShowCustomModel) btnShowCustomModel.innerHTML = '<i class="bi bi-pencil-square me-1"></i>手动输入';
            
            logToConsole(`已设置自定义模型: ${customModel}`, 'success');
        });
    }

    if (sfModelSelect) {
        sfModelSelect.addEventListener('change', function () {
            var hint = el('sf-model-hint');
            var selectedModel = sfModelSelect.value;
            if (selectedModel && (selectedModel.includes('A13B') || selectedModel.includes('收费'))) {
                if (!confirm('该模型可能为收费模型，调用将产生费用。\n确认切换为该模型吗？')) {
                    const prevModel = getLocalVal('siliconflow_model');
                    if (prevModel) {
                        for (let i = 0; i < sfModelSelect.options.length; i++) {
                            if (sfModelSelect.options[i].value === prevModel) {
                                sfModelSelect.selectedIndex = i;
                                break;
                            }
                        }
                    }
                    if (hint) hint.innerHTML = '<span class="text-info">请选择适合的翻译模型</span>';
                    return;
                }
            }
            if (hint && selectedModel) {
                if (selectedModel.includes('hunyuan') || selectedModel.includes('Hunyuan')) {
                    hint.innerHTML = '<span class="text-success"><i class="bi bi-star-fill me-1"></i>混元模型，适合翻译任务</span>';
                } else {
                    hint.innerHTML = '<span class="text-info">已选择模型: ' + selectedModel.split('/').pop() + '</span>';
                }
            }
        });
    }

    const saveApiBtn = el('btn-save-api');
    if (saveApiBtn) {
        saveApiBtn.addEventListener('click', function() {
            var key = sfApiKeyInput ? sfApiKeyInput.value.trim() : '';
            let model = '';
            let modelSource = 'select';
            
            if (sfModelSelect && sfModelSelect.selectedOptions[0]) {
                const selected = sfModelSelect.selectedOptions[0];
                if (selected.getAttribute && selected.getAttribute('data-custom') === 'true') {
                    model = selected.value;
                    modelSource = 'custom';
                } else {
                    model = selected.value;
                    modelSource = 'select';
                }
            }
            
            if (sfModelCustom && sfModelCustom.value.trim()) {
                const customModel = sfModelCustom.value.trim();
                if (confirm(`是否使用自定义模型 "${customModel}"？\n\n如果该模型不存在，API 调用可能会失败。`)) {
                    model = customModel;
                    modelSource = 'custom';
                    customModelValue = customModel;
                }
            }
            
            if (!key) { alert('请填写 API Key'); return; }
            if (!model) { alert('请选择或输入翻译模型'); return; }
            
            saveLocalConfig({ siliconflow_api_key: key, siliconflow_model: model, siliconflow_model_source: modelSource, siliconflow_model_custom: modelSource === 'custom' ? model : '' });
            socket.emit('save_settings', { siliconflow_api_key: key, siliconflow_model: model, siliconflow_model_source: modelSource });
            
            const modal = el('apiModal');
            if (modal && bootstrap.Modal) bootstrap.Modal.getInstance(modal).hide();
            logToConsole(`硅基流动 API 设置已保存。使用模型: ${model}`, 'success');
            refreshSiliconFlowModels();
        });
    }

    // ============ Terminology ============
    window.renderTermTable = function(terms) {
        var tbody = el('term-tbody'); if (!tbody) return;
        tbody.innerHTML = '';
        (terms || []).forEach(function(t) { addTermRow(t.source, t.target); });
    };
    window.addTermRow = function(src, tgt) {
        src = src || ''; tgt = tgt || '';
        var tbody = el('term-tbody');
        if (!tbody) return;
        var tr = document.createElement('tr');
        tr.className = 'term-row';
        tr.innerHTML = '<td><input type="text" class="form-control form-control-sm term-src" value="' + escHtml(src) + '"></td><td><input type="text" class="form-control form-control-sm term-tgt" value="' + escHtml(tgt) + '"></td><td><button class="btn btn-sm btn-outline-danger" onclick="this.closest(\'tr\').remove()"><i class="bi bi-trash3"></i></button></td>';
        tbody.appendChild(tr);
    };
    const saveTermBtn = el('btn-save-terminology');
    if (saveTermBtn) {
        saveTermBtn.addEventListener('click', function() {
            var rows = document.querySelectorAll('#term-tbody .term-row'), terms = [];
            rows.forEach(function(r) { var src = r.querySelector('.term-src').value.trim(), tgt = r.querySelector('.term-tgt').value.trim(); if (src) terms.push({ source: src, target: tgt || src }); });
            socket.emit('save_settings', { terminology: terms });
            const modal = el('termModal');
            if (modal && bootstrap.Modal) bootstrap.Modal.getInstance(modal).hide();
        });
    }

    // ============ Prompt ============
    const savePromptBtn = el('btn-save-prompt');
    if (savePromptBtn) {
        savePromptBtn.addEventListener('click', function() {
            var tmpl = el('prompt-editor') ? el('prompt-editor').value : '';
            if (tmpl.indexOf('{text}') === -1) { alert('Prompt 必须包含 {text} 变量'); return; }
            socket.emit('save_settings', { prompt_template: tmpl });
            const modal = el('promptModal');
            if (modal && bootstrap.Modal) bootstrap.Modal.getInstance(modal).hide();
        });
    }
    const resetPromptBtn = el('btn-reset-prompt');
    if (resetPromptBtn) {
        resetPromptBtn.addEventListener('click', function() {
            if (confirm('确定要恢复为默认 Prompt 吗？') && el('prompt-editor')) el('prompt-editor').value = DEFAULT_PROMPT;
        });
    }

    // ============ Browse Paths ============
    function browsePath(targetId, type) {
        fetch('/browse?type=' + type).then(function(r) { return r.json(); }).then(function(data) {
            if (!data.path) return;
            var input = el(targetId); if (input) input.value = data.path;
            if (targetId === 'cfg-whisperPath') saveLocalConfig({ whisper_path: data.path });
            if (targetId === 'cfg-hyPath') saveLocalConfig({ hy_path: data.path });
            if (targetId === 'audioFile') saveLocalConfig({ audio_file: data.path });
            if (targetId === 'jsonFile') { saveLocalConfig({ json_file: data.path }); socket.emit('load_json_for_preview', { path: data.path }); }
        }).catch(function(e) { console.error(e); alert('路径选择失败'); });
    }
    const browseAudioBtn = el('btn-browse-audio');
    if (browseAudioBtn) browseAudioBtn.addEventListener('click', function() { browsePath('audioFile', 'file'); });
    const browseJsonBtn = el('btn-browse-json');
    if (browseJsonBtn) browseJsonBtn.addEventListener('click', function() { browsePath('jsonFile', 'json'); });
    const browseWhisperBtn = el('btn-browse-cfg-whisper');
    if (browseWhisperBtn) browseWhisperBtn.addEventListener('click', function() { browsePath('cfg-whisperPath', 'dir'); });
    const browseHyBtn = el('btn-browse-cfg-hy');
    if (browseHyBtn) browseHyBtn.addEventListener('click', function() { browsePath('cfg-hyPath', 'dir'); });
    const refreshModelsBtnWhisper = el('btn-refresh-models');
    if (refreshModelsBtnWhisper) refreshModelsBtnWhisper.addEventListener('click', refreshWhisperModels);

    // ============ Whisper Model List ============
    function refreshWhisperModels() {
        fetch('/list_whisper_models').then(function(r) { return r.json(); }).then(function(data) {
            if (!whisperSelect) return;
            while (whisperSelect.options.length > 1) whisperSelect.remove(1);
            data.models.forEach(function(m) { whisperSelect.add(new Option(m.name, m.path)); });
            var saved = getLocalVal('whisper_path');
            if (saved) { for (var i = 0; i < whisperSelect.options.length; i++) { if (whisperSelect.options[i].value === saved) { whisperSelect.value = saved; break; } } }
        }).catch(function(e) { console.error('扫描 Whisper 模型失败:', e); });
    }

    // ============ Download Model Modal ============
    function ridOf(name) { return name.replace(/\W/g, '-'); }

    function loadDownloadableModels() {
        var container = el('download-model-list');
        if (!container) return;
        container.innerHTML = '<div class="text-center text-muted py-4"><div class="spinner-border spinner-border-sm me-2"></div>加载中...</div>';
        fetch('/list_downloadable_models').then(function(r) { return r.json(); }).then(function(data) {
            if (!data.models || !data.models.length) { container.innerHTML = '<p class="text-muted text-center py-4">无可用模型</p>'; return; }
            var html = '<div class="table-responsive"><table class="table table-dark table-hover table-sm align-middle mb-0">';
            html += '<thead><tr><th>模型名称</th><th>大小</th><th style="width:90px">状态</th><th style="width:170px">操作</th></tr></thead><tbody>';
            data.models.forEach(function(m) {
                var rid = ridOf(m.name);
                var repoUrl = 'https://huggingface.co/' + m.repo_id;
                var dlBtnHtml;
                if (m.downloaded) {
                    dlBtnHtml = '<button class="btn btn-sm btn-outline-secondary" disabled>已下载</button>';
                } else if (m.downloading) {
                    dlBtnHtml = '<button class="btn btn-sm btn-outline-warning" disabled>下载中...</button>';
                } else {
                    dlBtnHtml = '<button class="btn btn-sm btn-outline-primary btn-dl-model" data-repo="' + m.repo_id + '" data-name="' + escHtml(m.name) + '">下载</button>';
                }
                var statusBadge = m.downloaded ? '<span class="badge bg-success">已下载</span>' : (m.downloading ? '<span class="badge bg-warning text-dark">下载中</span>' : '<span class="badge bg-secondary">未下载</span>');
                html += '<tr id="dlrow-' + rid + '">';
                html += '<td class="fw-semibold">' + escHtml(m.name) + '</td>';
                html += '<td class="text-muted small">' + escHtml(m.size) + '</td>';
                html += '<td id="dlstatus-' + rid + '">' + statusBadge + '</td>';
                html += '<td class="d-flex gap-1">' + dlBtnHtml;
                html += '<a href="' + repoUrl + '" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary" title="查看 HuggingFace 仓库"><i class="bi bi-box-arrow-up-right"></i></a>';
                html += '</td></tr>';
                html += '<tr id="dlprog-row-' + rid + '" style="display:none"><td colspan="4" class="pt-0 pb-2 px-3">';
                html += '<div class="d-flex justify-content-between align-items-center mb-1">';
                html += '<small id="dlprog-txt-' + rid + '" class="text-muted text-truncate me-2" style="max-width:70%"></small>';
                html += '<small id="dlprog-pct-' + rid + '" class="text-muted text-nowrap"></small></div>';
                html += '<div class="progress" style="height:5px"><div id="dlprog-bar-' + rid + '" class="progress-bar progress-bar-striped progress-bar-animated" style="width:0%"></div></div>';
                html += '</td></tr>';
            });
            html += '</tbody></table></div>';
            container.innerHTML = html;
            container.querySelectorAll('.btn-dl-model').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var mirror = (el('hf-mirror-input') ? el('hf-mirror-input').value : 'https://hf-mirror.com').trim().replace(/\/$/, '');
                    startModelDownload(btn.getAttribute('data-repo'), btn.getAttribute('data-name'), mirror);
                    btn.disabled = true; btn.textContent = '下载中...';
                });
            });
        }).catch(function(e) {
            container.innerHTML = '<div class="text-center text-danger py-4"><i class="bi bi-exclamation-triangle me-2"></i>加载失败: ' + escHtml(e.message || '网络错误') + '</div>';
        });
    }

    function startModelDownload(repoId, modelName, mirror) {
        var rid = ridOf(modelName);
        var progRow = el('dlprog-row-' + rid); if (progRow) progRow.style.display = '';
        socket.emit('download_whisper_model', { repo_id: repoId, name: modelName, mirror: mirror });
    }

    socket.on('model_download_progress', function(d) {
        var rid = ridOf(d.model);
        var bar = el('dlprog-bar-' + rid), txt = el('dlprog-txt-' + rid), pct = el('dlprog-pct-' + rid);
        var progRow = el('dlprog-row-' + rid); if (progRow) progRow.style.display = '';
        if (bar) bar.style.width = d.file_pct + '%';
        if (txt) txt.textContent = '[' + d.file_index + '/' + d.total_files + '] ' + d.file;
        var speedStr = d.speed ? '  ' + d.speed : '';
        if (pct) pct.textContent = (d.downloaded_mb || 0) + ' / ' + (d.total_mb || '?') + ' MB (' + d.file_pct + '%)' + speedStr;
    });

    socket.on('model_download_log', function(d) {
        var rid = ridOf(d.model), txt = el('dlprog-txt-' + rid);
        var progRow = el('dlprog-row-' + rid); if (progRow) progRow.style.display = '';
        if (txt) txt.textContent = d.msg;
    });

    socket.on('model_download_done', function(d) {
        var rid = ridOf(d.model);
        var statusEl = el('dlstatus-' + rid); if (statusEl) statusEl.innerHTML = '<span class="badge bg-success">已下载</span>';
        var bar = el('dlprog-bar-' + rid);
        if (bar) { bar.style.width = '100%'; bar.classList.remove('progress-bar-animated', 'progress-bar-striped'); bar.classList.add('bg-success'); }
        var txt = el('dlprog-txt-' + rid); if (txt) txt.textContent = '下载完成！';
        var row = el('dlrow-' + rid);
        if (row) { var btn = row.querySelector('.btn-dl-model'); if (btn) { btn.disabled = true; btn.textContent = '已下载'; btn.classList.replace('btn-outline-primary', 'btn-outline-secondary'); } }
        refreshWhisperModels();
    });

    socket.on('model_download_error', function(d) {
        var rid = ridOf(d.model);
        var bar = el('dlprog-bar-' + rid);
        if (bar) { bar.style.width = '100%'; bar.classList.remove('progress-bar-animated', 'progress-bar-striped'); bar.classList.add('bg-danger'); }
        var txt = el('dlprog-txt-' + rid); if (txt) txt.textContent = '错误: ' + d.msg;
        var row = el('dlrow-' + rid);
        if (row) { var btn = row.querySelector('.btn-dl-model'); if (btn) { btn.disabled = false; btn.textContent = '重试'; } }
    });

    var dlModal = document.getElementById('downloadModelModal');
    if (dlModal) dlModal.addEventListener('show.bs.modal', loadDownloadableModels);

    // ============ Environment Check ============
    function runEnvCheck() {
        var container = el('env-check-results');
        if (!container) return;
        container.innerHTML = '<div class="text-center text-muted py-4"><div class="spinner-border spinner-border-sm me-2"></div>正在检测环境...</div>';
        fetch('/env_check').then(function(r) { return r.json(); }).then(function(data) {
            var html = '';
            data.results.forEach(function(item) {
                var icon = '', badge = '';
                if (item.status === 'ok') { icon = 'bi-check-circle-fill text-success'; badge = 'bg-success'; }
                else if (item.status === 'warn') { icon = 'bi-exclamation-triangle-fill text-warning'; badge = 'bg-warning text-dark'; }
                else { icon = 'bi-x-circle-fill text-danger'; badge = 'bg-danger'; }
                html += '<div class="d-flex align-items-start gap-3 p-2 rounded" style="background:rgba(255,255,255,.03)">';
                html += '<i class="bi ' + icon + ' fs-5 mt-1"></i>';
                html += '<div class="flex-grow-1"><div class="fw-semibold">' + escHtml(item.name) + '</div>';
                html += '<small class="text-muted">' + escHtml(item.detail) + '</small></div>';
                var statusText = item.status === 'ok' ? '正常' : (item.status === 'warn' ? '警告' : '缺失');
                html += '<span class="badge ' + badge + '">' + statusText + '</span>';
                html += '</div>';
            });
            container.innerHTML = html;
        }).catch(function(e) {
            container.innerHTML = '<div class="text-center text-danger py-4"><i class="bi bi-exclamation-triangle me-2"></i>检测失败: ' + escHtml(e.message || '网络错误') + '</div>';
        });
    }

    var envModal = document.getElementById('envCheckModal');
    if (envModal) {
        envModal.addEventListener('show.bs.modal', function() { runEnvCheck(); });
    }
    var btnRerun = el('btn-rerun-env-check');
    if (btnRerun) btnRerun.addEventListener('click', runEnvCheck);

    // ============ In-app Update ============
    var updateLogBox = el('update-log-box');
    var updateStatus = el('update-status-text');
    var btnDoCheck = el('btn-do-check');
    var btnDoUpdate = el('btn-do-update');
    var updateModal = document.getElementById('updateModal');

    function appendUpdateLog(line, level) {
        if (!updateLogBox) return;
        var colors = { success: 'text-success', error: 'text-danger', warn: 'text-warning' };
        var cls = colors[level] || 'text-info';
        var time = new Date().toLocaleTimeString();
        updateLogBox.innerHTML += '<div class="' + cls + '"><small class="text-muted me-2">' + time + '</small>' + escHtml(line) + '</div>';
        updateLogBox.scrollTop = updateLogBox.scrollHeight;
    }

    if (updateModal) {
        updateModal.addEventListener('show.bs.modal', function () {
            if (updateLogBox) updateLogBox.innerHTML = '点击"检查"开始检测...';
            if (updateStatus) updateStatus.textContent = '';
            if (btnDoUpdate) btnDoUpdate.classList.add('d-none');
        });
    }

    if (btnDoCheck) {
        btnDoCheck.addEventListener('click', function () {
            if (updateLogBox) updateLogBox.innerHTML = '';
            if (updateStatus) updateStatus.textContent = '检查中...';
            if (btnDoUpdate) btnDoUpdate.classList.add('d-none');
            btnDoCheck.disabled = true;
            socket.emit('check_update');
        });
    }

    if (btnDoUpdate) {
        btnDoUpdate.addEventListener('click', function () {
            if (updateLogBox) updateLogBox.innerHTML = '';
            if (updateStatus) updateStatus.textContent = '更新中...';
            btnDoUpdate.disabled = true;
            if (btnDoCheck) btnDoCheck.disabled = true;
            socket.emit('do_update');
        });
    }

    socket.on('update_log', function (d) { appendUpdateLog(d.line, d.level); });

    socket.on('update_done', function (d) {
        if (btnDoCheck) btnDoCheck.disabled = false;
        if (d.restart) {
            if (updateStatus) updateStatus.textContent = '重启中，页面将自动刷新...';
            setTimeout(function () { location.reload(); }, 3000);
        } else if (d.behind > 0) {
            if (updateStatus) updateStatus.textContent = '发现 ' + d.behind + ' 个新提交';
            if (btnDoUpdate) { btnDoUpdate.classList.remove('d-none'); btnDoUpdate.disabled = false; }
        } else {
            if (updateStatus) updateStatus.textContent = d.success ? '已是最新版本' : '更新失败';
        }
    });

    // ============ Reels Download ============
    function reelsItemHtml(idx, url) {
        var short = url.length > 70 ? url.slice(0, 70) + '…' : url;
        return '<div class="p-2 rounded" id="reels-item-' + idx + '" style="background:rgba(255,255,255,.04)">'
            + '<div class="d-flex align-items-center gap-2 mb-1">'
            + '<span class="badge bg-secondary" id="reels-badge-' + idx + '" style="min-width:52px">排队中</span>'
            + '<small class="text-muted text-truncate flex-grow-1" title="' + escHtml(url) + '">' + escHtml(short) + '</small>'
            + '<small class="text-nowrap text-muted" id="reels-meta-' + idx + '"></small>'
            + '</div>'
            + '<div class="progress mb-1" style="height:4px">'
            + '<div class="progress-bar progress-bar-striped progress-bar-animated" id="reels-bar-' + idx + '" style="width:0%"></div>'
            + '</div>'
            + '<small class="text-muted d-block text-truncate" id="reels-detail-' + idx + '"></small>'
            + '</div>';
    }

    const pasteReelsBtn = el('btn-paste-reels');
    if (pasteReelsBtn) {
        pasteReelsBtn.addEventListener('click', function () {
            if (!navigator.clipboard) { alert('浏览器不支持自动读取剪贴板，请手动粘贴 (Ctrl+V)'); return; }
            navigator.clipboard.readText().then(function (text) {
                var ta = el('reels-url-input');
                if (!ta) return;
                var cur = ta.value.trimEnd();
                ta.value = cur ? cur + '\n' + text.trim() : text.trim();
            }).catch(function () { alert('剪贴板访问被拒绝，请手动粘贴 (Ctrl+V)'); });
        });
    }

    const browseReelsDirBtn = el('btn-browse-reels-dir');
    if (browseReelsDirBtn) {
        browseReelsDirBtn.addEventListener('click', function () { browsePath('reels-output-dir', 'dir'); });
    }

    const clearReelsBtn = el('btn-clear-reels');
    if (clearReelsBtn) {
        clearReelsBtn.addEventListener('click', function () {
            const urlInput = el('reels-url-input');
            const progressList = el('reels-progress-list');
            const footerText = el('reels-footer-text');
            if (urlInput) urlInput.value = '';
            if (progressList) progressList.innerHTML = '';
            if (footerText) footerText.textContent = '';
        });
    }

    const startReelsBtn = el('btn-start-reels');
    if (startReelsBtn) {
        startReelsBtn.addEventListener('click', function () {
            const urlInput = el('reels-url-input');
            if (!urlInput) return;
            var raw = urlInput.value.trim();
            if (!raw) { alert('请输入至少一个 URL'); return; }
            var urls = raw.split('\n')
                .map(function (u) { return u.trim(); })
                .filter(function (u) { return u.startsWith('http://') || u.startsWith('https://'); });
            if (!urls.length) { alert('未检测到有效的 HTTP/HTTPS 链接'); return; }
            var outputDir = (el('reels-output-dir') ? el('reels-output-dir').value : '').trim();
            var list = el('reels-progress-list');
            if (list) {
                list.innerHTML = '';
                urls.forEach(function (u, i) { list.innerHTML += reelsItemHtml(i, u); });
            }
            var footerText = el('reels-footer-text');
            if (footerText) footerText.textContent = '正在下载 ' + urls.length + ' 个视频…';
            startReelsBtn.disabled = true;
            socket.emit('start_reels_download', { urls: urls, output_dir: outputDir });
        });
    }

    socket.on('reels_progress', function (d) {
        var i = d.index;
        var badge = el('reels-badge-' + i);
        var bar = el('reels-bar-' + i);
        var meta = el('reels-meta-' + i);
        var detail = el('reels-detail-' + i);
        if (d.status === 'start') {
            if (badge) { badge.textContent = '下载中'; badge.className = 'badge bg-primary'; }
        } else if (d.status === 'downloading') {
            var pct = d.percent || 0;
            if (bar) bar.style.width = pct + '%';
            var metaStr = pct + '%';
            if (d.speed) metaStr += '  ' + d.speed;
            if (d.eta) metaStr += '  ETA ' + d.eta;
            if (meta) meta.textContent = metaStr;
            if (d.total_mb && detail) {
                detail.textContent = (d.downloaded_mb || 0) + ' / ' + d.total_mb + ' MB';
            }
        } else if (d.status === 'finished') {
            if (badge) { badge.textContent = '完成'; badge.className = 'badge bg-success'; }
            if (bar) { bar.style.width = '100%'; bar.classList.remove('progress-bar-animated', 'progress-bar-striped'); bar.classList.add('bg-success'); }
            if (meta) meta.textContent = '';
            if (detail && d.filename) detail.textContent = d.filename;
        } else if (d.status === 'error') {
            if (badge) { badge.textContent = '失败'; badge.className = 'badge bg-danger'; }
            if (bar) { bar.style.width = '100%'; bar.classList.remove('progress-bar-animated', 'progress-bar-striped'); bar.classList.add('bg-danger'); }
            if (detail) detail.textContent = '错误: ' + (d.msg || '未知错误');
            if (meta) meta.textContent = '';
        }
    });

    socket.on('reels_done', function (d) {
        var footerEl = el('reels-footer-text');
        if (footerEl) footerEl.textContent = '全部完成！共 ' + d.total + ' 个，保存至：' + d.output_dir;
        var btn = el('btn-start-reels'); if (btn) btn.disabled = false;
    });

    socket.on('reels_error', function (d) {
        var footerEl = el('reels-footer-text');
        if (footerEl) footerEl.textContent = '错误：' + d.msg;
        var btn = el('btn-start-reels'); if (btn) btn.disabled = false;
    });

    // ============ Init ============
    restoreFromLocal();
});