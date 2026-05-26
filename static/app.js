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
    const sfApiKeyInput = el('sfApiKey'), sfModelSelect = el('sfModel');
    const cfgWhisperPath = el('cfg-whisperPath'), cfgHyPath = el('cfg-hyPath');
    const langSelect = el('setting-language'), modeHint = el('translate-mode-hint');
    const buttons = { asr: el('btn-asr'), translateJson: el('btn-translate-json') };

    // ============ State ============
    let taskFinished = true;
    let tableData = { original: [], translated: [] };

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
            const ot = o.text ? escHtml(o.text) : '<span class="text-muted">\u2014</span>';
            const tt = t.text ? escHtml(t.text) : '<span class="text-muted">\u2014</span>';
            html += '<tr><td class="text-muted">' + (i+1) + '</td><td style="font-size:.78rem">' + time + '</td><td>' + ot + '</td><td>' + tt + '</td></tr>';
        }
        previewTbody.innerHTML = html;
        tableStats.textContent = orig.length + ' 条原文 / ' + trans.length + ' 条译文';
    };

    function updateTranslateModeUI(mode) {
        if (modeHint) modeHint.textContent = mode === 'api' ? '使用硅基流动 API 在线翻译' : '使用本地混元模型翻译';
    }

    function getConfig() {
        return {
            whisper_path: whisperSelect.value || getLocalVal('whisper_path'),
            hy_path: cfgHyPath.value || getLocalVal('hy_path'),
            audio_file: audioFileInput.value,
            language: langSelect.value || 'pt',
            whisper_device: (document.querySelector('input[name="whisperDevice"]:checked') || {}).value || 'cuda',
            translate_mode: (document.querySelector('input[name="translateMode"]:checked') || {}).value || 'local',
            siliconflow_api_key: sfApiKeyInput.value || getLocalVal('siliconflow_api_key'),
            siliconflow_model: sfModelSelect.value || getLocalVal('siliconflow_model', 'tencent/Hunyuan-MT-7B'),
        };
    }

    function restoreFromLocal() {
        const cfg = loadLocalConfig();
        if (cfg.whisper_path && cfgWhisperPath) cfgWhisperPath.value = cfg.whisper_path;
        if (cfg.hy_path && cfgHyPath) cfgHyPath.value = cfg.hy_path;
        if (cfg.language && langSelect) langSelect.value = cfg.language;
        if (cfg.whisper_device) { const r = document.querySelector('input[name="whisperDevice"][value="' + cfg.whisper_device + '"]'); if (r) r.checked = true; }
        if (cfg.translate_mode) { const r = document.querySelector('input[name="translateMode"][value="' + cfg.translate_mode + '"]'); if (r) r.checked = true; }
        updateTranslateModeUI(cfg.translate_mode || 'local');
        if (cfg.siliconflow_api_key && sfApiKeyInput) sfApiKeyInput.value = cfg.siliconflow_api_key;
        if (cfg.siliconflow_model && sfModelSelect) {
            sfModelSelect.value = cfg.siliconflow_model;
            // 若本地保存的是旧模型名（不在选项内），回退到免费模型
            if (!sfModelSelect.value) sfModelSelect.value = 'tencent/Hunyuan-MT-7B';
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
        if (sfModelSelect) sfModelSelect.value = local.siliconflow_model || cfg.siliconflow_model || 'tencent/Hunyuan-MT-7B';
        saveLocalConfig({ whisper_path: wp, hy_path: hp, language: langSelect.value, whisper_device: dev, translate_mode: mode, siliconflow_api_key: sfApiKeyInput.value, siliconflow_model: sfModelSelect.value });
        logToConsole('初始配置加载完毕。', 'success');
        refreshWhisperModels();
    });

    socket.on('log', function(d) { logToConsole(d.msg); });
    socket.on('progress', function(d) { setProgress(d.value, d.text); });
    socket.on('task_done', function(d) { taskFinished = true; logToConsole('<b>' + d.msg + '</b>', 'success'); setProgress(100, '完成'); toggleButtons(true); });
    socket.on('task_error', function(d) { taskFinished = true; logToConsole('<b>' + d.msg + '</b>', 'error'); failProgress('任务出错'); toggleButtons(true); });
    socket.on('file_preview', function(d) { if (d.type === 'original') tableData.original = d.content || []; if (d.type === 'translated') tableData.translated = d.content || []; renderTable(); });
    socket.on('settings_saved', function(d) { logToConsole('[设置] ' + d.msg, d.success ? 'success' : 'error'); });

    // ============ Tasks ============
    buttons.asr.addEventListener('click', function() {
        var cfg = getConfig();
        if (!cfg.whisper_path) { alert('请先设置 Whisper 模型路径（导航栏 → 模型路径 或下拉选择）'); return; }
        if (!cfg.audio_file) { alert('请先选择音频文件'); return; }
        taskFinished = false; tableData = { original: [], translated: [] }; renderTable(); setProgress(0, ''); toggleButtons(false);
        logToConsole('--- 开始语音识别任务 ---');
        socket.emit('start_task', Object.assign({ task: 'asr' }, cfg));
    });

    buttons.translateJson.addEventListener('click', function() {
        var cfg = getConfig();
        var jsonPath = jsonFileInput.value.trim();
        if (!jsonPath) { alert('请先选择 JSON 文件'); return; }
        if (cfg.translate_mode !== 'api' && !cfg.hy_path) { alert('请先设置混元翻译模型路径（导航栏 → 模型路径）或切换为 API 模式'); return; }
        if (cfg.translate_mode === 'api' && !cfg.siliconflow_api_key) { alert('请先设置硅基流动 API Key（导航栏 → 硅基流动 API）'); return; }
        taskFinished = false; tableData.translated = []; renderTable(); setProgress(0, ''); toggleButtons(false);
        logToConsole('--- 开始翻译 JSON 字幕 ---');
        socket.emit('start_task', Object.assign({ task: 'translate_json', json_file: jsonPath }, cfg));
    });

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
        if (val) { saveLocalConfig({ whisper_path: val }); if (cfgWhisperPath) cfgWhisperPath.value = val; socket.emit('save_config', { whisper_path: val, hy_path: cfgHyPath.value }); }
    });

    // ============ Modal: Model Paths ============
    el('btn-save-model-paths').addEventListener('click', function() {
        var wp = cfgWhisperPath.value.trim(), hp = cfgHyPath.value.trim();
        saveLocalConfig({ whisper_path: wp, hy_path: hp });
        socket.emit('save_config', { whisper_path: wp, hy_path: hp });
        if (wp && whisperSelect) { for (var i = 0; i < whisperSelect.options.length; i++) { if (whisperSelect.options[i].value === wp) { whisperSelect.value = wp; break; } } }
        bootstrap.Modal.getInstance(el('modelPathModal')).hide();
        logToConsole('模型路径已保存。', 'success');
    });

    // ============ Modal: API ============
    if (sfModelSelect) sfModelSelect.addEventListener('change', function () {
        var hint = el('sf-model-hint');
        if (sfModelSelect.value === 'tencent/Hunyuan-A13B-Instruct') {
            if (!confirm('Hunyuan-A13B-Instruct 为收费模型，调用将产生费用。\n确认切换为该模型吗？')) {
                sfModelSelect.value = 'tencent/Hunyuan-MT-7B';
                if (hint) hint.textContent = '混元机器翻译专用模型，适合字幕翻译场景。';
                return;
            }
            if (hint) hint.innerHTML = '<span class="text-warning"><i class="bi bi-coin me-1"></i>收费模型，请确认账户余额充足。</span>';
        } else {
            if (hint) hint.textContent = '混元机器翻译专用模型，适合字幕翻译场景。';
        }
    });
    el('btn-save-api').addEventListener('click', function() {
        var key = sfApiKeyInput.value.trim(), model = sfModelSelect.value;
        saveLocalConfig({ siliconflow_api_key: key, siliconflow_model: model });
        socket.emit('save_settings', { siliconflow_api_key: key, siliconflow_model: model });
        bootstrap.Modal.getInstance(el('apiModal')).hide();
        logToConsole('硅基流动 API 设置已保存。', 'success');
    });

    // ============ Terminology ============
    window.renderTermTable = function(terms) {
        var tbody = el('term-tbody'); tbody.innerHTML = '';
        (terms || []).forEach(function(t) { addTermRow(t.source, t.target); });
    };
    window.addTermRow = function(src, tgt) {
        src = src || ''; tgt = tgt || '';
        var tbody = el('term-tbody'), tr = document.createElement('tr');
        tr.className = 'term-row';
        tr.innerHTML = '<td><input type="text" class="form-control form-control-sm term-src" value="' + escHtml(src) + '"></td><td><input type="text" class="form-control form-control-sm term-tgt" value="' + escHtml(tgt) + '"></td><td><button class="btn btn-sm btn-outline-danger" onclick="this.closest(\'tr\').remove()"><i class="bi bi-trash3"></i></button></td>';
        tbody.appendChild(tr);
    };
    el('btn-save-terminology').addEventListener('click', function() {
        var rows = document.querySelectorAll('#term-tbody .term-row'), terms = [];
        rows.forEach(function(r) { var src = r.querySelector('.term-src').value.trim(), tgt = r.querySelector('.term-tgt').value.trim(); if (src) terms.push({ source: src, target: tgt || src }); });
        socket.emit('save_settings', { terminology: terms });
        bootstrap.Modal.getInstance(el('termModal')).hide();
    });

    // ============ Prompt ============
    el('btn-save-prompt').addEventListener('click', function() {
        var tmpl = el('prompt-editor').value;
        if (tmpl.indexOf('{text}') === -1) { alert('Prompt 必须包含 {text} 变量'); return; }
        socket.emit('save_settings', { prompt_template: tmpl });
        bootstrap.Modal.getInstance(el('promptModal')).hide();
    });
    el('btn-reset-prompt').addEventListener('click', function() {
        if (confirm('确定要恢复为默认 Prompt 吗？')) el('prompt-editor').value = DEFAULT_PROMPT;
    });

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
    el('btn-browse-audio').addEventListener('click', function() { browsePath('audioFile', 'file'); });
    el('btn-browse-json').addEventListener('click', function() { browsePath('jsonFile', 'json'); });
    el('btn-browse-cfg-whisper').addEventListener('click', function() { browsePath('cfg-whisperPath', 'dir'); });
    el('btn-browse-cfg-hy').addEventListener('click', function() { browsePath('cfg-hyPath', 'dir'); });
    el('btn-refresh-models').addEventListener('click', refreshWhisperModels);

    // ============ Whisper Model List ============
    function refreshWhisperModels() {
        fetch('/list_whisper_models').then(function(r) { return r.json(); }).then(function(data) {
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
                // 进度行（默认隐藏）
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
                    var mirror = (el('hf-mirror-input').value || 'https://hf-mirror.com').trim().replace(/\/$/, '');
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
            updateLogBox.innerHTML = '点击"检查"开始检测...';
            if (updateStatus) updateStatus.textContent = '';
            if (btnDoUpdate) btnDoUpdate.classList.add('d-none');
        });
    }

    if (btnDoCheck) {
        btnDoCheck.addEventListener('click', function () {
            updateLogBox.innerHTML = '';
            if (updateStatus) updateStatus.textContent = '检查中...';
            if (btnDoUpdate) btnDoUpdate.classList.add('d-none');
            btnDoCheck.disabled = true;
            socket.emit('check_update');
        });
    }

    if (btnDoUpdate) {
        btnDoUpdate.addEventListener('click', function () {
            updateLogBox.innerHTML = '';
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

    if (el('btn-paste-reels')) {
        el('btn-paste-reels').addEventListener('click', function () {
            if (!navigator.clipboard) { alert('浏览器不支持自动读取剪贴板，请手动粘贴 (Ctrl+V)'); return; }
            navigator.clipboard.readText().then(function (text) {
                var ta = el('reels-url-input');
                var cur = ta.value.trimEnd();
                ta.value = cur ? cur + '\n' + text.trim() : text.trim();
            }).catch(function () { alert('剪贴板访问被拒绝，请手动粘贴 (Ctrl+V)'); });
        });
    }

    if (el('btn-browse-reels-dir')) {
        el('btn-browse-reels-dir').addEventListener('click', function () { browsePath('reels-output-dir', 'dir'); });
    }

    if (el('btn-clear-reels')) {
        el('btn-clear-reels').addEventListener('click', function () {
            el('reels-url-input').value = '';
            el('reels-progress-list').innerHTML = '';
            el('reels-footer-text').textContent = '';
        });
    }

    if (el('btn-start-reels')) {
        el('btn-start-reels').addEventListener('click', function () {
            var raw = (el('reels-url-input').value || '').trim();
            if (!raw) { alert('请输入至少一个 URL'); return; }
            var urls = raw.split('\n')
                .map(function (u) { return u.trim(); })
                .filter(function (u) { return u.startsWith('http://') || u.startsWith('https://'); });
            if (!urls.length) { alert('未检测到有效的 HTTP/HTTPS 链接'); return; }
            var outputDir = (el('reels-output-dir').value || '').trim();
            var list = el('reels-progress-list');
            list.innerHTML = '';
            urls.forEach(function (u, i) { list.innerHTML += reelsItemHtml(i, u); });
            el('reels-footer-text').textContent = '正在下载 ' + urls.length + ' 个视频…';
            el('btn-start-reels').disabled = true;
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
            if (d.total_mb) {
                if (detail) detail.textContent = (d.downloaded_mb || 0) + ' / ' + d.total_mb + ' MB';
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
