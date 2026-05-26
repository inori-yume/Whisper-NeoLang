"""
Flask Web UI for Whisper-HY Tool
"""
import os
import sys
import json
import webbrowser
from threading import Thread, Lock
from flask import Flask, render_template, request
from flask_socketio import SocketIO

# --- 环境配置与动态加载 ---
def _configure_environment():
    os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
    os.environ["TORCHINDUCTOR_DISABLE"] = "1"
    import logging
    logging.getLogger("torch._dynamo").setLevel(logging.CRITICAL)
_configure_environment()

# --- Flask 应用设置 ---
app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app, async_mode='threading')

# --- 全局变量与锁 ---
if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(BASE_DIR, "models")
CONFIG_FILE = os.path.join(BASE_DIR, "web_config.json")
TRANSLATE_CONFIG_FILE = os.path.join(BASE_DIR, "translate_config.json")

model_lock = Lock()
models = {"whisper": None, "hy": None, "tokenizer": None, "whisper_device": None}

# --- 默认配置常量 ---
_DEFAULT_LANGUAGE = "pt"
_DEFAULT_TERMINOLOGY = [
    {"source": "Eco",      "target": "Eco"},
    {"source": "Rush",     "target": "Rush"},
    {"source": "Save",     "target": "Save"},
    {"source": "Major",    "target": "Major"},
    {"source": "Site",     "target": "Site"},
    {"source": "CT",       "target": "CT"},
    {"source": "T",        "target": "T"},
    {"source": "AWP",      "target": "AWP"},
    {"source": "AK",       "target": "AK"},
    {"source": "M4",       "target": "M4"},
    {"source": "Molotov",  "target": "Molotov"},
    {"source": "Flash",    "target": "Flash"},
    {"source": "Smoke",    "target": "Smoke"},
    {"source": "Nuke",     "target": "Nuke"},
    {"source": "Dust2",    "target": "Dust2"},
    {"source": "Inferno",  "target": "Inferno"},
    {"source": "Mirage",   "target": "Mirage"},
]
_DEFAULT_PROMPT_TEMPLATE = (
    "参考下面的翻译：\n{terms}\n\n"
    "将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n{text}"
)

# --- 可下载 Whisper 模型列表 ---
_DOWNLOADABLE_WHISPER_MODELS = [
    {"name": "faster-whisper-tiny",     "repo_id": "Systran/faster-whisper-tiny",     "size": "~75 MB"},
    {"name": "faster-whisper-base",     "repo_id": "Systran/faster-whisper-base",     "size": "~145 MB"},
    {"name": "faster-whisper-small",    "repo_id": "Systran/faster-whisper-small",    "size": "~488 MB"},
    {"name": "faster-whisper-medium",   "repo_id": "Systran/faster-whisper-medium",   "size": "~1.5 GB"},
    {"name": "faster-whisper-large-v2", "repo_id": "Systran/faster-whisper-large-v2", "size": "~3.0 GB"},
    {"name": "faster-whisper-large-v3", "repo_id": "Systran/faster-whisper-large-v3", "size": "~3.1 GB"},
]
_downloading_models = set()  # 正在下载的模型名集合

# --- SocketIO 事件处理 ---
@socketio.on('connect')
def handle_connect():
    emit_log('客户端已连接。')

@socketio.on('get_initial_config')
def get_initial_config():
    config = _load_config()
    translate_cfg = _load_translate_config()
    config.setdefault('language', _DEFAULT_LANGUAGE)
    config['terminology'] = translate_cfg.get('terminology', _DEFAULT_TERMINOLOGY)
    config['prompt_template'] = translate_cfg.get('prompt_template', _DEFAULT_PROMPT_TEMPLATE)
    config.setdefault('whisper_device', 'cuda')
    config.setdefault('translate_mode', 'local')
    config.setdefault('siliconflow_api_key', '')
    config.setdefault('siliconflow_model', 'Qwen/Qwen2.5-7B-Instruct')
    socketio.emit('initial_config', config)

@socketio.on('save_settings')
def save_settings(data):
    """保存语言、Whisper 设备、翻译模式及 API 配置到 web_config.json，术语表和 Prompt 保存到 translate_config.json。"""
    try:
        web_fields = {k: v for k, v in data.items()
                      if k in ('language', 'whisper_device', 'translate_mode',
                               'siliconflow_api_key', 'siliconflow_model')}
        if web_fields:
            _save_config(web_fields)
        translate_fields = {k: v for k, v in data.items() if k in ('terminology', 'prompt_template')}
        if translate_fields:
            _save_translate_config(translate_fields)
        socketio.emit('settings_saved', {'msg': '设置已保存', 'success': True})
    except Exception as e:
        socketio.emit('settings_saved', {'msg': f'设置保存失败: {e}', 'success': False})

@socketio.on('load_json_for_preview')
def load_json_for_preview(data):
    """读取指定 JSON 文件并推送到前端原文预览列。"""
    path = data.get('path', '')
    if not path or not os.path.exists(path):
        return
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = json.load(f)
        emit_preview('original', content)
    except Exception as e:
        emit_log(f'[警告] 预览 JSON 失败: {e}')

@socketio.on('save_config')
def save_config(data):
    _save_config(data)
    emit_log('配置已保存。')

@socketio.on('start_task')
def start_task(data):
    task = data.get('task')
    paths = {k: data.get(k) for k in ['whisper_path', 'hy_path', 'audio_file']}
    # 语言、术语、Prompt 从请求中取，未传则读配置文件兜底
    config = _load_config()
    paths['language'] = data.get('language') or config.get('language', _DEFAULT_LANGUAGE)
    paths['whisper_device'] = data.get('whisper_device') or config.get('whisper_device', 'cuda')
    paths['translate_mode'] = data.get('translate_mode') or config.get('translate_mode', 'local')
    paths['siliconflow_api_key'] = data.get('siliconflow_api_key') or config.get('siliconflow_api_key', '')
    paths['siliconflow_model'] = data.get('siliconflow_model') or config.get('siliconflow_model', 'Qwen/Qwen2.5-7B-Instruct')

    is_api_translate = paths['translate_mode'] == 'api'
    # ASR 只需要 whisper_path + audio_file
    if task == 'asr':
        if not paths.get('whisper_path') or not paths.get('audio_file'):
            emit_error("语音识别需要设置 Whisper 模型路径和音频文件！")
            return
    elif task in ('translate', 'pipeline'):
        if not is_api_translate and not all(paths[k] for k in ['whisper_path', 'hy_path', 'audio_file']):
            emit_error("所有路径都必须填写！")
            return
    if task in ('translate_json', 'translate') and not is_api_translate and not paths.get('hy_path'):
        emit_error("请设置混元翻译模型路径或切换为 API 翻译模式！")
        return

    # 仅保存路径类字段
    _save_config({k: paths[k] for k in ['whisper_path', 'hy_path'] if paths.get(k)})

    if task == 'asr':
        Thread(target=_asr_worker, args=(paths, True)).start()
    elif task == 'translate':
        Thread(target=_translate_worker, args=(paths, True)).start()
    elif task == 'translate_json':
        json_path = data.get('json_file', '')
        if not json_path or not os.path.exists(json_path):
            emit_error(f'找不到 JSON 文件: {json_path}')
            return
        Thread(target=_translate_json_worker, args=(paths, json_path)).start()
    elif task == 'pipeline':
        Thread(target=_pipeline_worker, args=(paths,)).start()

@socketio.on('direct_translate')
def direct_translate(data):
    text = data.get('text')
    config = _load_config()
    paths = {k: data.get(k) for k in ['whisper_path', 'hy_path']}
    paths['translate_mode'] = data.get('translate_mode') or config.get('translate_mode', 'local')
    paths['siliconflow_api_key'] = data.get('siliconflow_api_key') or config.get('siliconflow_api_key', '')
    paths['siliconflow_model'] = data.get('siliconflow_model') or config.get('siliconflow_model', 'Qwen/Qwen2.5-7B-Instruct')
    is_api = paths['translate_mode'] == 'api'
    if not text:
        emit_error("快速翻译需要输入文本。")
        return
    if not is_api and not paths.get('hy_path'):
        emit_error("请设置混元翻译模型路径或切换为 API 翻译模式。")
        return
    Thread(target=_direct_translate_worker, args=(text, paths)).start()

# --- 工具函数 ---
def emit_log(msg):
    socketio.emit('log', {'msg': msg})

def emit_progress(value, text):
    socketio.emit('progress', {'value': value, 'text': text})

def emit_error(msg):
    socketio.emit('task_error', {'msg': msg})

def emit_done(msg):
    socketio.emit('task_done', {'msg': msg})

def emit_preview(data_type, content):
    socketio.emit('file_preview', {'type': data_type, 'content': content})

def _load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {}
    return {}

def _save_config(data):
    current_config = _load_config()
    current_config.update(data)
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(current_config, f, indent=2)

def _load_translate_config():
    if os.path.exists(TRANSLATE_CONFIG_FILE):
        try:
            with open(TRANSLATE_CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {}
    return {}

def _save_translate_config(data):
    current = _load_translate_config()
    current.update(data)
    with open(TRANSLATE_CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(current, f, ensure_ascii=False, indent=2)

def _to_srt_time(seconds: float) -> str:
    ms = int((seconds - int(seconds)) * 1000)
    h, r = divmod(int(seconds), 3600)
    m, s = divmod(r, 60)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"

# --- 模型加载与管理 ---
def _ensure_model(model_type, path, device='cuda'):
    # 必须在 torch 已导入后才能设置，此处是最早的安全时机
    import torch._dynamo
    torch._dynamo.config.suppress_errors = True

    with model_lock:
        if model_type == 'whisper':
            # 设备切换时强制重新加载
            if models['whisper'] is not None and models['whisper_device'] != device:
                models['whisper'] = None
            if models['whisper'] is None:
                from faster_whisper import WhisperModel
                compute_type = "float16" if device == "cuda" else "int8"
                emit_log(f"正在加载 Whisper 模型 ({device.upper()})...")
                models['whisper'] = WhisperModel(path, device=device, compute_type=compute_type, local_files_only=True)
                models['whisper_device'] = device
                emit_log("Whisper 模型加载完成。")
        elif model_type == 'hy' and models['hy'] is None:
            from transformers import AutoModelForCausalLM, AutoTokenizer
            emit_log("正在加载混元翻译模型...")
            models['tokenizer'] = AutoTokenizer.from_pretrained(path, use_fast=False, trust_remote_code=True)
            import torch
            models['hy'] = AutoModelForCausalLM.from_pretrained(
                path, device_map="auto", torch_dtype=torch.float16, trust_remote_code=True, low_cpu_mem_usage=True)
            emit_log("混元翻译模型加载完成。")

def _release_model(model_type):
    """安全释放模型显存：先在锁内清除引用，再在锁外执行 GC，
    避免 CTranslate2 / CUDA 析构时与锁产生死锁或引发底层崩溃。"""
    try:
        import torch, gc
        with model_lock:
            if model_type == 'whisper' and models['whisper'] is not None:
                models['whisper'] = None
            elif model_type == 'hy' and models['hy'] is not None:
                models['hy'] = None
                models['tokenizer'] = None
        # 在锁外执行 CUDA 清理，防止析构时持锁死锁
        gc.collect()
        torch.cuda.empty_cache()
        emit_log(f"{model_type} 模型显存已释放。")
    except Exception as e:
        emit_log(f"[警告] 显存释放时出现异常（不影响功能）: {e}")

# --- 后台工作线程 ---
def _asr_worker(paths, standalone=False):
    # standalone=True: 进度 0→100%，完成后发 task_done 并恢复按钮
    # standalone=False (流水线): 进度 0→50%，由 pipeline 负责后续
    end_pct = 100 if standalone else 50
    device = paths.get('whisper_device', 'cuda')
    try:
        _ensure_model('whisper', paths['whisper_path'], device=device)
        emit_progress(5, "开始识别...")

        segments, info = models['whisper'].transcribe(
            paths['audio_file'],
            language=paths.get('language', _DEFAULT_LANGUAGE),
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
            initial_prompt="CS2, Major, esports, FalleN, fer, fnx, coldzera, taco")

        results, total_dur = [], info.duration
        def _fmt_dur(sec):
            m, s = divmod(int(sec), 60)
            return f"{m:02}:{s:02}"
        for s in segments:
            results.append({"start": _to_srt_time(s.start), "end": _to_srt_time(s.end), "text": s.text})
            pct = min(s.end / total_dur * 100, 99)
            emit_log(f"[{_fmt_dur(s.start)} / {_fmt_dur(total_dur)}] {s.text.strip()}")
            emit_progress(5 + int(pct * 0.45 * (end_pct / 50)), "识别中...")

        _audio_stem = os.path.splitext(os.path.basename(paths['audio_file']))[0]
        out_path = os.path.join(os.path.dirname(paths['audio_file']), f"{_audio_stem}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)

        emit_preview('original', results)
        emit_progress(end_pct, "识别完成！")
        if standalone:
            emit_done("语音识别任务完成！")
        return True
    except Exception as e:
        emit_error(f"ASR 任务失败: {e}")
        return False
    finally:
        _release_model('whisper')

def _translate_json_worker(paths, json_path: str):
    """直接读取指定 JSON 文件进行翻译，不依赖音频文件路径。"""
    import json as _json
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            transcription = _json.load(f)
    except Exception as e:
        emit_error(f'读取 JSON 文件失败: {e}')
        return

    # 输出到 JSON 同级目录，且文件名与输入 JSON 保持一致
    output_dir = os.path.dirname(json_path)
    output_stem = os.path.splitext(os.path.basename(json_path))[0]
    _translate_worker_core(paths, transcription, output_dir, output_stem=output_stem)


def _translate_worker(paths, standalone=False):
    # standalone=True: 进度 0→100%
    # standalone=False (流水线): 进度 50→100%
    start_pct = 0 if standalone else 50
    _audio_stem = os.path.splitext(os.path.basename(paths['audio_file']))[0]
    json_path = os.path.join(os.path.dirname(paths['audio_file']), f"{_audio_stem}.json")
    if not os.path.exists(json_path):
        emit_error(f"未找到识别结果文件: {json_path}")
        return False

    with open(json_path, "r", encoding="utf-8") as f:
        transcription = json.load(f)

    output_dir = os.path.dirname(paths['audio_file'])
    return _translate_worker_core(
        paths,
        transcription,
        output_dir,
        start_pct=start_pct,
        output_stem=_audio_stem,
    )


def _translate_worker_core(paths, transcription: list, output_dir: str, start_pct: int = 0, output_stem: str = ""):
    """翻译核心逻辑，供 _translate_worker 和 _translate_json_worker 共用。"""
    translate_mode = paths.get('translate_mode', 'local')
    is_api = translate_mode == 'api'
    try:
        if not is_api:
            _ensure_model('hy', paths['hy_path'])
        emit_progress(start_pct + 5, "开始翻译...")

        results, total_items = [], len(transcription)
        for i, item in enumerate(transcription):
            text = item["text"].strip()
            if not text:
                continue

            if is_api:
                translated = _call_siliconflow_api(
                    text,
                    paths.get('siliconflow_api_key', ''),
                    paths.get('siliconflow_model', 'Qwen/Qwen2.5-7B-Instruct')
                )
            else:
                translated = _call_hy(text)

            results.append({"start": item["start"], "end": item["end"], "text": translated})
            pct = (i + 1) / total_items * 100
            emit_log(f"[{i + 1} / {total_items}] {translated}")
            emit_progress(start_pct + 5 + int(pct * 0.9 * ((100 - start_pct) / 100)), f"翻译中 {i + 1}/{total_items}...")

        if not output_stem:
            output_stem = "final_chinese_subtitles"
        srt_path = os.path.join(output_dir, f"{output_stem}.srt")
        with open(srt_path, "w", encoding="utf-8") as f:
            for i, r in enumerate(results, 1):
                f.write(f"{i}\n{r['start']} --> {r['end']}\n{r['text']}\n\n")

        emit_preview('translated', results)
        emit_done("翻译任务完成！")
        return True
    except Exception as e:
        emit_error(f"翻译任务失败: {e}")
        return False
    finally:
        if not is_api:
            _release_model('hy')


def _pipeline_worker(paths):
    if _asr_worker(paths):
        _translate_worker(paths)

def _direct_translate_worker(text, paths):
    is_api = paths.get('translate_mode') == 'api'
    try:
        if is_api:
            translated_text = _call_siliconflow_api(
                text,
                paths.get('siliconflow_api_key', ''),
                paths.get('siliconflow_model', 'Qwen/Qwen2.5-7B-Instruct')
            )
        else:
            _ensure_model('hy', paths['hy_path'])
            translated_text = _call_hy(text)
        socketio.emit('direct_translate_result', {'text': translated_text})
    except Exception as e:
        emit_error(f"快速翻译失败: {e}")
    finally:
        if not is_api:
            _release_model('hy')

def _call_siliconflow_api(text: str, api_key: str, model: str) -> str:
    """调用硅基流动兼容 OpenAI 的 API 进行翻译。"""
    import requests
    if not api_key:
        raise ValueError("硅基流动 API Key 未配置，请在设置中填写。")
    translate_cfg = _load_translate_config()
    terminology = translate_cfg.get('terminology', _DEFAULT_TERMINOLOGY)
    prompt_template = translate_cfg.get('prompt_template', _DEFAULT_PROMPT_TEMPLATE)
    terms_text = "\n".join(f"{t['source']} 翻译成 {t['target']}" for t in terminology)
    prompt = prompt_template.format(terms=terms_text, text=text)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 512,
        "temperature": 0.7,
        "stream": False
    }
    resp = requests.post(
        "https://api.siliconflow.cn/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=30
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"].strip()


def _call_hy(text: str) -> str:
    """调用混元模型翻译，术语表和 Prompt 从 translate_config.json 读取。"""
    import torch
    translate_cfg = _load_translate_config()
    terminology = translate_cfg.get('terminology', _DEFAULT_TERMINOLOGY)
    prompt_template = translate_cfg.get('prompt_template', _DEFAULT_PROMPT_TEMPLATE)

    terms_text = "\n".join(f"{t['source']} 翻译成 {t['target']}" for t in terminology)
    prompt = prompt_template.format(terms=terms_text, text=text)

    messages = [{"role": "user", "content": prompt}]
    ids = models["tokenizer"].apply_chat_template(
        messages, tokenize=True, add_generation_prompt=True, return_tensors="pt").to("cuda")

    with torch.no_grad():
        out_ids = models["hy"].generate(
            ids, max_new_tokens=256, top_k=20, top_p=0.6,
            temperature=0.7, repetition_penalty=1.05, do_sample=True)

    return models["tokenizer"].decode(out_ids[0][ids.shape[1]:], skip_special_tokens=True).strip()

# --- Flask 路由 ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/list_whisper_models')
def list_whisper_models():
    """扫描 MODELS_DIR 下包含 vocabulary.json 的子目录（faster-whisper 模型特征）。"""
    found = []
    os.makedirs(MODELS_DIR, exist_ok=True)
    try:
        for name in sorted(os.listdir(MODELS_DIR)):
            full = os.path.join(MODELS_DIR, name)
            if os.path.isdir(full) and os.path.exists(os.path.join(full, 'vocabulary.json')):
                found.append({'name': name, 'path': full})
    except Exception:
        pass
    return {'models': found}

@app.route('/env_check')
def env_check():
    """环境自检：检查 CUDA、虚拟环境、必要组件、模型目录。"""
    import subprocess, shutil
    results = []

    # 1. CUDA 版本
    try:
        import torch
        if torch.cuda.is_available():
            cuda_ver = torch.version.cuda or '未知'
            gpu_name = torch.cuda.get_device_name(0)
            results.append({'name': 'CUDA', 'status': 'ok', 'detail': f'CUDA {cuda_ver} — {gpu_name}'})
        else:
            results.append({'name': 'CUDA', 'status': 'warn', 'detail': 'torch.cuda 不可用（仅 CPU 模式可用）'})
    except ImportError:
        results.append({'name': 'CUDA', 'status': 'fail', 'detail': 'PyTorch 未安装，无法检测 CUDA'})
    except Exception as e:
        results.append({'name': 'CUDA', 'status': 'fail', 'detail': str(e)})

    # 2. 虚拟环境
    in_venv = (hasattr(sys, 'real_prefix') or
               (hasattr(sys, 'base_prefix') and sys.base_prefix != sys.prefix))
    venv_path = sys.prefix
    if in_venv:
        results.append({'name': '虚拟环境', 'status': 'ok', 'detail': f'已激活: {venv_path}'})
    else:
        results.append({'name': '虚拟环境', 'status': 'warn', 'detail': f'未使用虚拟环境 (当前: {venv_path})'})

    # 3. 必要组件
    required_packages = [
        ('torch', 'PyTorch'),
        ('transformers', 'Transformers'),
        ('faster_whisper', 'Faster-Whisper'),
        ('flask', 'Flask'),
        ('flask_socketio', 'Flask-SocketIO'),
        ('optimum', 'Optimum'),
        ('gptqmodel', 'GPTQModel'),
        ('accelerate', 'Accelerate'),
        ('tqdm', 'tqdm'),
    ]
    for mod_name, display_name in required_packages:
        try:
            mod = __import__(mod_name)
            ver = getattr(mod, '__version__', '已安装')
            results.append({'name': display_name, 'status': 'ok', 'detail': f'v{ver}'})
        except ImportError:
            results.append({'name': display_name, 'status': 'fail', 'detail': '未安装'})

    # 4. Whisper 模型（必要）
    whisper_models = []
    try:
        for name in sorted(os.listdir(MODELS_DIR)):
            full = os.path.join(MODELS_DIR, name)
            if os.path.isdir(full) and os.path.exists(os.path.join(full, 'vocabulary.json')):
                whisper_models.append(name)
    except Exception:
        pass
    if whisper_models:
        results.append({'name': 'Whisper 模型', 'status': 'ok', 'detail': '、'.join(whisper_models)})
    else:
        results.append({'name': 'Whisper 模型', 'status': 'fail', 'detail': '未检测到（需包含 vocabulary.json 的目录）'})

    # 5. HY 翻译模型（非必要）
    hy_models = []
    try:
        for name in sorted(os.listdir(MODELS_DIR)):
            full = os.path.join(MODELS_DIR, name)
            if os.path.isdir(full) and os.path.exists(os.path.join(full, 'tokenizer_config.json')):
                # 排除 whisper 模型
                if not os.path.exists(os.path.join(full, 'vocabulary.json')):
                    hy_models.append(name)
    except Exception:
        pass
    if hy_models:
        results.append({'name': 'HY 翻译模型', 'status': 'ok', 'detail': '、'.join(hy_models)})
    else:
        results.append({'name': 'HY 翻译模型', 'status': 'warn', 'detail': '未检测到（非必要，可使用 API 模式）'})

    # 6. Python 版本
    py_ver = f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}'
    results.append({'name': 'Python', 'status': 'ok', 'detail': f'v{py_ver} ({sys.executable})'})

    return {'results': results}

@app.route('/browse')
def browse():
    """在服务端弹出系统原生选择框，将路径返回给前端。"""
    import tkinter as tk
    from tkinter import filedialog
    browse_type = request.args.get('type', 'dir')  # dir | file | json
    root = tk.Tk()
    root.withdraw()       # 不显示 Tk 主窗口
    root.wm_attributes('-topmost', True)  # 对话框置顶
    if browse_type == 'file':
        path = filedialog.askopenfilename(
            title='选择音频文件',
            filetypes=[('音频文件', '*.mp3 *.wav *.m4a *.flac *.aac'), ('所有文件', '*.*')],
        )
    elif browse_type == 'json':
        path = filedialog.askopenfilename(
            title='选择识别结果 JSON 文件',
            filetypes=[('JSON 文件', '*.json'), ('所有文件', '*.*')],
        )
    else:
        path = filedialog.askdirectory(title='选择文件夹')
    root.destroy()
    return {'path': path or ''}

@app.route('/list_downloadable_models')
def list_downloadable_models():
    """返回可下载的 Whisper 模型列表及本地下载状态。"""
    result = []
    for m in _DOWNLOADABLE_WHISPER_MODELS:
        local_dir = os.path.join(MODELS_DIR, m['name'])
        downloaded = (os.path.isdir(local_dir) and
                      os.path.exists(os.path.join(local_dir, 'vocabulary.json')))
        result.append({**m, 'downloaded': downloaded,
                        'downloading': m['name'] in _downloading_models})
    return {'models': result}


@socketio.on('download_whisper_model')
def on_download_whisper_model(data):
    repo_id   = (data.get('repo_id')   or '').strip()
    model_name = (data.get('name')     or '').strip()
    mirror    = (data.get('mirror')    or 'https://hf-mirror.com').strip().rstrip('/')
    sid = request.sid
    # 白名单校验，防止路径穿越
    valid_names = {m['name'] for m in _DOWNLOADABLE_WHISPER_MODELS}
    if model_name not in valid_names or '/' not in repo_id:
        socketio.emit('model_download_error', {'model': model_name, 'msg': '无效的模型参数'}, to=sid)
        return
    if model_name in _downloading_models:
        socketio.emit('model_download_error', {'model': model_name, 'msg': '该模型正在下载中，请等待完成'}, to=sid)
        return
    _downloading_models.add(model_name)
    Thread(target=_download_model_worker, args=(repo_id, model_name, mirror, sid)).start()


def _download_model_worker(repo_id, model_name, mirror, sid):
    """后台线程：逐文件流式下载模型并实时推送进度。"""
    import requests as _req
    import time as _time

    def _log(msg):
        socketio.emit('model_download_log', {'model': model_name, 'msg': msg}, to=sid)

    def _prog(payload):
        socketio.emit('model_download_progress', payload, to=sid)

    target_dir = os.path.join(MODELS_DIR, model_name)
    try:
        os.makedirs(target_dir, exist_ok=True)
        _log(f'镜像源: {mirror}')
        _log('正在获取文件列表...')

        files = None
        # 优先用 huggingface_hub（支持 endpoint 参数），回退到原始 API
        for ep in [mirror, 'https://huggingface.co']:
            try:
                from huggingface_hub import HfApi
                api = HfApi(endpoint=ep)
                files = list(api.list_repo_files(repo_id=repo_id, repo_type='model'))
                break
            except Exception:
                pass
        if not files:
            for ep in [mirror, 'https://huggingface.co']:
                try:
                    r = _req.get(f'{ep}/api/models/{repo_id}', timeout=30)
                    r.raise_for_status()
                    files = [f['rfilename'] for f in r.json().get('siblings', [])]
                    if files:
                        break
                except Exception:
                    pass
        if not files:
            raise RuntimeError('无法获取文件列表，请检查网络或镜像源')

        total_files = len(files)
        _log(f'共 {total_files} 个文件，开始下载...')

        for i, filename in enumerate(files):
            file_url = f'{mirror}/{repo_id}/resolve/main/{filename}'
            # 处理子目录（如 subdir/file.bin）
            rel_parts = filename.replace('\\', '/').split('/')
            target_path = os.path.join(target_dir, *rel_parts)
            os.makedirs(os.path.dirname(target_path), exist_ok=True)

            _prog({'model': model_name, 'file': filename,
                   'file_index': i + 1, 'total_files': total_files,
                   'file_pct': 0, 'downloaded_mb': 0, 'total_mb': 0, 'speed': ''})

            # timeout=(连接超时, 读取超时)；读取设为 None，避免大文件被提前中断
            with _req.get(file_url, stream=True, timeout=(15, None),
                          allow_redirects=True) as resp:
                resp.raise_for_status()
                effective_url = resp.url  # 跟随重定向后的实际 URL
                if effective_url != file_url:
                    _log(f'重定向至: {effective_url[:80]}...')
                total_size = int(resp.headers.get('content-length', 0))
                downloaded = 0
                last_emit = -1
                t0 = _time.monotonic()
                speed_bytes = 0
                speed_t = t0

                with open(target_path, 'wb') as f:
                    for chunk in resp.iter_content(chunk_size=512 * 1024):
                        if chunk:
                            f.write(chunk)
                            downloaded += len(chunk)
                            speed_bytes += len(chunk)
                            now = _time.monotonic()
                            elapsed = now - speed_t
                            # 每 1 MB 或完成时推送一次进度
                            if downloaded - last_emit >= 1024 * 1024 or downloaded == total_size:
                                last_emit = downloaded
                                pct = int(downloaded / total_size * 100) if total_size else 0
                                speed_str = ''
                                if elapsed > 0.5:
                                    spd = speed_bytes / elapsed
                                    speed_bytes = 0
                                    speed_t = now
                                    if spd > 1024 * 1024:
                                        speed_str = f'{spd / 1024 / 1024:.1f} MB/s'
                                    else:
                                        speed_str = f'{spd / 1024:.0f} KB/s'
                                _prog({
                                    'model': model_name,
                                    'file': filename,
                                    'file_index': i + 1,
                                    'total_files': total_files,
                                    'file_pct': pct,
                                    'downloaded_mb': round(downloaded / 1024 / 1024, 1),
                                    'total_mb': round(total_size / 1024 / 1024, 1),
                                    'speed': speed_str,
                                })

        socketio.emit('model_download_done', {'model': model_name}, to=sid)
    except Exception as e:
        socketio.emit('model_download_error', {'model': model_name, 'msg': str(e)}, to=sid)
    finally:
        _downloading_models.discard(model_name)


# ---------------------------------------------------------------------------
# Instagram Reels 下载
# ---------------------------------------------------------------------------
_REELS_DEFAULT_DIR = os.path.join(BASE_DIR, 'reels_downloads')


@socketio.on('start_reels_download')
def on_start_reels_download(data):
    raw_urls = data.get('urls', [])
    output_dir = (data.get('output_dir') or '').strip()
    sid = request.sid

    # 仅允许 HTTP/HTTPS，防止任意协议注入
    valid_urls = [u.strip() for u in raw_urls
                  if u.strip().startswith(('http://', 'https://'))]
    if not valid_urls:
        socketio.emit('reels_error', {'msg': '没有检测到有效的 HTTP/HTTPS 链接'}, to=sid)
        return

    # 目录路径只允许绝对路径，防止路径穿越
    if output_dir:
        output_dir = os.path.abspath(output_dir)
    else:
        output_dir = _REELS_DEFAULT_DIR

    Thread(target=_reels_download_worker, args=(valid_urls, output_dir, sid)).start()


def _reels_download_worker(urls, output_dir, sid):
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        socketio.emit('reels_error',
                      {'msg': 'yt-dlp 未安装，请在虚拟环境中运行: pip install yt-dlp'},
                      to=sid)
        return

    os.makedirs(output_dir, exist_ok=True)

    for idx, url in enumerate(urls):
        socketio.emit('reels_progress',
                      {'index': idx, 'url': url, 'status': 'start', 'total': len(urls)},
                      to=sid)

        def _hook(d, _idx=idx, _url=url):
            if d['status'] == 'downloading':
                dl = d.get('downloaded_bytes') or 0
                total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
                pct = int(dl / total * 100) if total else 0
                spd = d.get('speed') or 0
                if spd > 1024 * 1024:
                    spd_str = f'{spd / 1024 / 1024:.1f} MB/s'
                elif spd > 0:
                    spd_str = f'{spd / 1024:.0f} KB/s'
                else:
                    spd_str = ''
                eta = d.get('eta') or 0
                socketio.emit('reels_progress', {
                    'index': _idx, 'url': _url, 'status': 'downloading',
                    'percent': pct, 'speed': spd_str,
                    'eta': f'{eta}s' if eta else '',
                    'downloaded_mb': round(dl / 1024 / 1024, 1),
                    'total_mb': round(total / 1024 / 1024, 1),
                }, to=sid)
            elif d['status'] == 'finished':
                socketio.emit('reels_progress', {
                    'index': _idx, 'url': _url, 'status': 'finished',
                    'filename': os.path.basename(d.get('filename', '')),
                }, to=sid)

        ydl_opts = {
            'outtmpl': os.path.join(output_dir, '%(uploader)s_%(upload_date)s_%(id)s.%(ext)s'),
            'progress_hooks': [_hook],
            'quiet': True,
            'no_warnings': True,
            'merge_output_format': 'mp4',
        }

        try:
            import yt_dlp
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])
        except Exception as e:
            socketio.emit('reels_progress', {
                'index': idx, 'url': url, 'status': 'error', 'msg': str(e),
            }, to=sid)

    socketio.emit('reels_done', {'total': len(urls), 'output_dir': output_dir}, to=sid)


# ---------------------------------------------------------------------------
# 在线更新（git pull + pip install）
# ---------------------------------------------------------------------------
@socketio.on('check_update')
def on_check_update():
    sid = request.sid
    Thread(target=_update_worker, args=(False, sid)).start()


@socketio.on('do_update')
def on_do_update():
    sid = request.sid
    Thread(target=_update_worker, args=(True, sid)).start()


def _update_worker(do_pull: bool, sid: str):
    def _emit(line, level='info'):
        socketio.emit('update_log', {'line': line, 'level': level}, to=sid)

    try:
        import subprocess as _sp

        # ── 检查 git ────────────────────────────────────────────
        git = _sp.run(['git', '-C', BASE_DIR, 'rev-parse', '--is-inside-work-tree'],
                      capture_output=True, text=True)
        if git.returncode != 0:
            _emit('当前目录不是 Git 仓库，无法自动更新。', 'error')
            _emit('请手动下载最新代码替换项目文件。', 'warn')
            socketio.emit('update_done', {'success': False, 'restart': False}, to=sid)
            return

        if not do_pull:
            # 仅检查：fetch + 对比提交数
            _emit('正在从远端获取信息（git fetch）...')
            _sp.run(['git', '-C', BASE_DIR, 'fetch'], capture_output=True)
            behind = _sp.run(
                ['git', '-C', BASE_DIR, 'rev-list', 'HEAD..@{u}', '--count'],
                capture_output=True, text=True).stdout.strip()
            ahead = _sp.run(
                ['git', '-C', BASE_DIR, 'rev-list', '@{u}..HEAD', '--count'],
                capture_output=True, text=True).stdout.strip()
            if behind == '0':
                _emit('已是最新版本，无需更新。', 'success')
                socketio.emit('update_done', {'success': True, 'restart': False,
                                              'behind': 0}, to=sid)
            else:
                _emit(f'发现 {behind} 个新提交，可点击"立即更新"。', 'warn')
                socketio.emit('update_done', {'success': True, 'restart': False,
                                              'behind': int(behind or 0)}, to=sid)
            return

        # ── 执行更新 ────────────────────────────────────────────
        # 记录 requirements.txt 旧哈希
        import hashlib
        def _hash(p):
            try:
                return hashlib.md5(open(p, 'rb').read()).hexdigest()
            except FileNotFoundError:
                return ''

        req_path = os.path.join(BASE_DIR, 'requirements.txt')
        old_req_hash = _hash(req_path)

        _emit('执行 git pull...')
        pull = _sp.run(['git', '-C', BASE_DIR, 'pull'],
                       capture_output=True, text=True)
        for line in (pull.stdout + pull.stderr).splitlines():
            _emit(line)
        if pull.returncode != 0:
            _emit('git pull 失败，请检查网络或手动解决冲突。', 'error')
            socketio.emit('update_done', {'success': False, 'restart': False}, to=sid)
            return

        # ── 依赖是否变化 ─────────────────────────────────────────
        needs_pip = _hash(req_path) != old_req_hash
        if needs_pip:
            _emit('requirements.txt 已变更，正在更新依赖...')
            pip = _sp.run([sys.executable, '-m', 'pip', 'install', '-r', req_path],
                          capture_output=True, text=True)
            for line in (pip.stdout + pip.stderr).splitlines():
                _emit(line)
            if pip.returncode != 0:
                _emit('依赖安装失败，请手动运行 pip install -r requirements.txt。', 'error')
                socketio.emit('update_done', {'success': False, 'restart': False}, to=sid)
                return
            _emit('依赖更新完成。', 'success')
            # 更新 .req_hash 标记（供 launcher.py 使用）
            marker = os.path.join(BASE_DIR, '.venv', '.req_hash')
            if os.path.exists(os.path.dirname(marker)):
                with open(marker, 'w') as f:
                    f.write(_hash(req_path))
        else:
            _emit('依赖无变化，跳过 pip install。')

        _emit('更新完成！服务即将重启...', 'success')
        socketio.emit('update_done', {'success': True, 'restart': True}, to=sid)

        # 延迟 1.5 秒后重启进程（给前端响应时间）
        def _restart():
            import time
            time.sleep(1.5)
            os.execv(sys.executable, [sys.executable] + sys.argv)
        Thread(target=_restart, daemon=True).start()

    except Exception as e:
        _emit(f'更新过程出错: {e}', 'error')
        socketio.emit('update_done', {'success': False, 'restart': False}, to=sid)


def run_app():
    # 在新线程中打开浏览器，避免阻塞
    Thread(target=lambda: webbrowser.open_new("http://127.0.0.1:5000")).start()
    # use_reloader=False: 禁止 werkzeug 文件监视器，防止动态 import 大型库时触发进程重启
    socketio.run(app, host='127.0.0.1', port=5000, allow_unsafe_werkzeug=True, use_reloader=False)

if __name__ == '__main__':
    run_app()
