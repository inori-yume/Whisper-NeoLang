document.addEventListener('DOMContentLoaded', function () {
    const socket = io();
    document._appSocket = socket; // 供 browsePath 函数调用

    // --- 状态 ---
    let taskFinished = false;
    let tableData = { original: [], translated: [] };
    // 默认 Prompt（与后端保持一致，用于"恢复默认"）
    const DEFAULT_PROMPT = "参考下面的翻译：\n{terms}\n\n将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n{text}";

    // --- DOM ---
    const consoleEl       = document.getElementById('console');
    const progressBar     = document.getElementById('progress-bar');
    const progressWrap    = document.getElementById('progress-wrap');
    const progressText    = document.getElementById('progress-text');
    const whisperPathInput = document.getElementById('whisperPath');
    const hyPathInput      = document.getElementById('hyPath');
    const audioFileInput   = document.getElementById('audioFile');
    const jsonFileInput    = document.getElementById('jsonFile');
    const directInput      = document.getElementById('direct-input');
    const directOutput     = document.getElementById('direct-output');
    const previewTbody     = document.getElementById('preview-tbody');
    const tableStats       = document.getElementById('table-stats');

    const buttons = {
        asr:            document.getElementById('btn-asr'),
        translateJson:  document.getElementById('btn-translate-json'),
        directTranslate:document.getElementById('btn-direct-translate'),
    };

    // --- 工具：日志 ---
    const logToConsole = (msg, type = 'info') => {
        const time = new Date().toLocaleTimeString();
        let icon = '';
        switch(type) {
            case 'info': icon = '<i class="bi bi-info-circle text-info"></i>'; break;
            case 'success': icon = '<i class="bi bi-check-circle text-success"></i>'; break;
            case 'error': icon = '<i class="bi bi-exclamation-triangle text-danger"></i>'; break;
            case 'io': icon = '<i class="bi bi-reception-4 text-primary"></i>'; break;
        }
        consoleEl.innerHTML += `<div><small class="text-muted me-2">${time}</small>${icon} ${msg}</div>`;
        consoleEl.scrollTop = consoleEl.scrollHeight;
    };

    // --- 工具：进度条 ---
    const setProgress = (value, text) => {
        progressWrap.style.display = 'block';
        progressBar.classList.add('progress-bar-animated', 'progress-bar-striped');
        progressBar.style.width = `${value}%`;
        progressBar.classList.remove('bg-success', 'bg-danger');

        if (value === 100) {
            progressBar.classList.add('bg-success');
            progressBar.classList.remove('progress-bar-animated', 'progress-bar-striped');
            setTimeout(() => {
                 progressWrap.style.display = 'none';
                 progressText.textContent = '';
                 setProgress(0, '');
            }, 3000);
        }
        progressText.textContent = text || '';
    };

    const failProgress = (text) => {
        progressBar.style.width = `100%`;
        progressBar.classList.add('bg-danger');
        progressBar.classList.remove('progress-bar-animated', 'progress-bar-striped');
        progressText.textContent = text || '任务失败';
        toggleButtons(true);
    }

    // --- 工具：按钮开关 ---
    const toggleButtons = (enable) => {
        Object.values(buttons).forEach(b => { if (b) b.disabled = !enable; });
    };

    // --- 工具：合并表格渲染 ---
    const renderTable = () => {
        const orig  = tableData.original;
        const trans = tableData.translated;
        const len   = Math.max(orig.length, trans.length);
        if (len === 0) {
            previewTbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-5">暂无数据</td></tr>';
            tableStats.textContent = '';
            return;
        }
        let html = '';
        for (let i = 0; i < len; i++) {
            const o = orig[i]  || {};
            const t = trans[i] || {};
            const time      = o.start ? `${o.start}<br><small class="text-muted">${o.end}</small>` : '';
            const origText  = o.text  ? escHtml(o.text)  : '<span class="text-muted">—</span>';
            const transText = t.text  ? escHtml(t.text)  : '<span class="text-muted">—</span>';
            html += `<tr><td class="text-muted">${i+1}</td><td style="font-size:.78rem">${time}</td><td>${origText}</td><td>${transText}</td></tr>`;
        }
        previewTbody.innerHTML = html;
        tableStats.textContent = `${orig.length} 条原文 / ${trans.length} 条译文`;
    };

    const escHtml = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // --- Socket.IO 事件 ---
    socket.on('connect', () => {
        logToConsole('已连接到后端服务。', 'io');
        socket.emit('get_initial_config');
    });

    socket.on('disconnect', () => {
        logToConsole('与后端服务断开连接。', 'error');
        if (!taskFinished) toggleButtons(false);
    });

    socket.on('reconnect', () => {
        logToConsole('已重新连接到后端服务。', 'io');
        if (taskFinished) toggleButtons(true);
    });

    socket.on('initial_config', (cfg) => {
        whisperPathInput.value = cfg.whisper_path || '';
        hyPathInput.value      = cfg.hy_path      || '';
        // 语言选择
        const langSel = document.getElementById('setting-language');
        if (langSel && cfg.language) langSel.value = cfg.language;
        // 术语表
        if (cfg.terminology) renderTermTable(cfg.terminology);
        // Prompt
        const promptEl = document.getElementById('prompt-editor');
        if (promptEl) promptEl.value = cfg.prompt_template || DEFAULT_PROMPT;
        logToConsole('初始配置加载完毕。', 'success');
    });

    socket.on('log',      (d) => logToConsole(d.msg));
    socket.on('progress', (d) => setProgress(d.value, d.text));

    socket.on('task_done', (d) => {
        taskFinished = true;
        logToConsole(`<b>${d.msg}</b>`, 'success');
        setProgress(100, '完成');
        toggleButtons(true);
    });

    socket.on('task_error', (d) => {
        taskFinished = true;
        logToConsole(`<b>${d.msg}</b>`, 'error');
        failProgress('任务出错');
        toggleButtons(true);
    });

    socket.on('file_preview', (d) => {
        if (d.type === 'original')   tableData.original   = d.content || [];
        if (d.type === 'translated') tableData.translated = d.content || [];
        renderTable();
    });

    socket.on('direct_translate_result', (d) => {
        directOutput.value = d.text;
        buttons.directTranslate.disabled = false;
        buttons.directTranslate.innerHTML = '<i class="bi bi-arrow-right-circle me-1"></i> 翻译';
    });

    socket.on('settings_saved', (d) => {
        alert(d.msg);
        logToConsole(`[设置] ${d.msg}`, 'success');
    });

    // --- 任务启动 ---
    const getPaths = () => ({
        whisper_path: whisperPathInput.value,
        hy_path:      hyPathInput.value,
        audio_file:   audioFileInput.value,
        language:     (document.getElementById('setting-language') || {}).value || 'pt',
    });

    const startTask = (task, label, requiredPaths = []) => {
        for (const path of requiredPaths) {
            if (!document.getElementById(path).value.trim()) {
                const name = document.querySelector(`label[for="${path}"]`)?.textContent || path;
                alert(`请先设置 ${name}`);
                return;
            }
        }

        taskFinished = false;
        tableData = { original: [], translated: [] };
        renderTable();
        setProgress(0, '');
        toggleButtons(false);
        logToConsole(`--- ${label} ---`);
        socket.emit('start_task', { task, ...getPaths() });
    };

    buttons.asr.addEventListener('click', () => startTask('asr', '开始语音识别任务', ['whisperPath', 'audioFile']));

    buttons.translateJson.addEventListener('click', () => {
        const jsonPath = jsonFileInput.value.trim();
        if (!jsonPath) { alert('请先选择 transcription.json 文件'); return; }
        if (!hyPathInput.value.trim()) { alert('请先设置混元翻译模型路径'); return; }

        taskFinished = false;
        tableData.translated = [];
        renderTable();
        setProgress(0, '');
        toggleButtons(false);
        logToConsole('--- 开始从 JSON 直接翻译任务 ---');
        socket.emit('start_task', {
            task:         'translate_json',
            json_file:    jsonPath,
            hy_path:      hyPathInput.value,
        });
    });

    buttons.directTranslate.addEventListener('click', () => {
        const text = directInput.value.trim();
        if (!text) return;
        if (!hyPathInput.value.trim()) { alert('请先设置混元翻译模型路径'); return; }

        buttons.directTranslate.disabled = true;
        buttons.directTranslate.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';
        socket.emit('direct_translate', { text, hy_path: hyPathInput.value });
    });

    // --- 路径自动保存 ---
    [whisperPathInput, hyPathInput].forEach(inp => {
        inp.addEventListener('change', () => {
            socket.emit('save_config', { whisper_path: whisperPathInput.value, hy_path: hyPathInput.value });
        });
    });

    // --- 语言设置 ---
    window.saveLangSettings = () => {
        const lang = document.getElementById('setting-language').value;
        socket.emit('save_settings', { language: lang });
        bootstrap.Modal.getInstance(document.getElementById('langModal')).hide();
    };

    // --- 术语表 ---
    window.renderTermTable = (terms) => {
        const tbody = document.getElementById('term-tbody');
        tbody.innerHTML = '';
        (terms || []).forEach((t) => addTermRow(t.source, t.target));
    };

    window.addTermRow = (src = '', tgt = '') => {
        const tbody = document.getElementById('term-tbody');
        const tr = document.createElement('tr');
        tr.className = 'term-row';
        tr.innerHTML = `
            <td><input type="text" class="form-control form-control-sm term-src" value="${escHtml(src)}"></td>
            <td><input type="text" class="form-control form-control-sm term-tgt" value="${escHtml(tgt)}"></td>
            <td><button class="btn btn-sm btn-outline-danger" onclick="this.closest('tr').remove()"><i class="bi bi-trash3"></i></button></td>`;
        tbody.appendChild(tr);
    };

    window.saveTerminology = () => {
        const rows  = document.querySelectorAll('#term-tbody .term-row');
        const terms = [];
        rows.forEach(r => {
            const src = r.querySelector('.term-src').value.trim();
            const tgt = r.querySelector('.term-tgt').value.trim();
            if (src) terms.push({ source: src, target: tgt || src });
        });
        socket.emit('save_settings', { terminology: terms });
        bootstrap.Modal.getInstance(document.getElementById('termModal')).hide();
    };

    // --- Prompt 编辑 ---
    window.savePrompt = () => {
        const tmpl = document.getElementById('prompt-editor').value;
        if (!tmpl.includes('{text}')) { alert('Prompt 必须包含 {text} 变量'); return; }
        socket.emit('save_settings', { prompt_template: tmpl });
        bootstrap.Modal.getInstance(document.getElementById('promptModal')).hide();
    };

    window.resetPrompt = () => {
        if (confirm('确定要恢复为默认 Prompt 吗？')) {
            document.getElementById('prompt-editor').value = DEFAULT_PROMPT;
        }
    };
});

// --- 路径浏览（调用后端弹窗）---
async function browsePath(targetId, type) {
    try {
        const res  = await fetch(`/browse?type=${type}`);
        const data = await res.json();
        if (!data.path) return;
        const input = document.getElementById(targetId);
        input.value = data.path;
        input.dispatchEvent(new Event('change'));
        // JSON 文件选择后立即加载预览
        if (targetId === 'jsonFile') {
            document._appSocket && document._appSocket.emit('load_json_for_preview', { path: data.path });
        }
    } catch (e) {
        console.error('路径选择失败:', e);
        alert('路径选择失败，请检查后端日志。');
    }
}