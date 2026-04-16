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
CONFIG_FILE = os.path.join(BASE_DIR, "web_config.json")
TRANSLATE_CONFIG_FILE = os.path.join(BASE_DIR, "translate_config.json")

model_lock = Lock()
models = {"whisper": None, "hy": None, "tokenizer": None}

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
    socketio.emit('initial_config', config)

@socketio.on('save_settings')
def save_settings(data):
    """保存语言到 web_config.json，术语表和 Prompt 保存到 translate_config.json。"""
    try:
        if 'language' in data:
            _save_config({'language': data['language']})
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
def start_task(data):
    task = data.get('task')
    paths = {k: data.get(k) for k in ['whisper_path', 'hy_path', 'audio_file']}
    # 语言、术语、Prompt 从请求中取，未传则读配置文件兜底
    config = _load_config()
    paths['language'] = data.get('language') or config.get('language', _DEFAULT_LANGUAGE)

    if task not in ('translate_json',) and not all(paths[k] for k in ['whisper_path', 'hy_path', 'audio_file']):
        emit_error("所有路径都必须填写！")
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
    paths = {k: data.get(k) for k in ['whisper_path', 'hy_path']}
    if not text or not all(paths.values()):
        emit_error("快速翻译需要输入文本和完整的模型路径。")
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
def _ensure_model(model_type, path):
    # 必须在 torch 已导入后才能设置，此处是最早的安全时机
    import torch._dynamo
    torch._dynamo.config.suppress_errors = True

    with model_lock:
        if model_type == 'whisper' and models['whisper'] is None:
            from faster_whisper import WhisperModel
            emit_log("正在加载 Whisper 模型...")
            models['whisper'] = WhisperModel(path, device="cuda", compute_type="float16", local_files_only=True)
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
    try:
        _ensure_model('whisper', paths['whisper_path'])
        emit_progress(5, "开始识别...")

        segments, info = models['whisper'].transcribe(
            paths['audio_file'],
            language=paths.get('language', _DEFAULT_LANGUAGE),
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
            initial_prompt="CS2, Major, esports, FalleN, fer, fnx, coldzera, taco")

        results, total_dur = [], info.duration
        for s in segments:
            results.append({"start": _to_srt_time(s.start), "end": _to_srt_time(s.end), "text": s.text})
            pct = min(s.end / total_dur * 100, 99)
            emit_progress(5 + int(pct * 0.45 * (end_pct / 50)), f"识别中: {s.text.strip()[:30]}...")

        out_path = os.path.join(os.path.dirname(paths['audio_file']), "transcription.json")
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

    # 复用 _translate_worker 逻辑，output 输出到 JSON 同级目录
    output_dir = os.path.dirname(json_path)
    _translate_worker_core(paths, transcription, output_dir)


def _translate_worker(paths, standalone=False):
    # standalone=True: 进度 0→100%
    # standalone=False (流水线): 进度 50→100%
    start_pct = 0 if standalone else 50
    json_path = os.path.join(os.path.dirname(paths['audio_file']), "transcription.json")
    if not os.path.exists(json_path):
        emit_error(f"未找到识别结果文件: {json_path}")
        return False

    with open(json_path, "r", encoding="utf-8") as f:
        transcription = json.load(f)

    output_dir = os.path.dirname(paths['audio_file'])
    return _translate_worker_core(paths, transcription, output_dir, start_pct=start_pct)


def _translate_worker_core(paths, transcription: list, output_dir: str, start_pct: int = 0):
    """翻译核心逻辑，供 _translate_worker 和 _translate_json_worker 共用。"""
    try:
        _ensure_model('hy', paths['hy_path'])
        emit_progress(start_pct + 5, "开始翻译...")

        results, total_items = [], len(transcription)
        for i, item in enumerate(transcription):
            text = item["text"].strip()
            if not text: continue

            translated = _call_hy(text)
            results.append({"start": item["start"], "end": item["end"], "text": translated})
            pct = (i + 1) / total_items * 100
            emit_progress(start_pct + 5 + int(pct * 0.9 * ((100 - start_pct) / 100)),
                          f"翻译中: {translated[:30]}...")

        srt_path = os.path.join(output_dir, "final_chinese_subtitles.srt")
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
        _release_model('hy')


def _pipeline_worker(paths):
    if _asr_worker(paths):
        _translate_worker(paths)

def _direct_translate_worker(text, paths):
    try:
        _ensure_model('hy', paths['hy_path'])
        translated_text = _call_hy(text)
        socketio.emit('direct_translate_result', {'text': translated_text})
    except Exception as e:
        emit_error(f"快速翻译失败: {e}")
    finally:
        _release_model('hy')

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

def run_app():
    # 在新线程中打开浏览器，避免阻塞
    Thread(target=lambda: webbrowser.open_new("http://127.0.0.1:5000")).start()
    # use_reloader=False: 禁止 werkzeug 文件监视器，防止动态 import 大型库时触发进程重启
    socketio.run(app, host='127.0.0.1', port=5000, allow_unsafe_werkzeug=True, use_reloader=False)

if __name__ == '__main__':
    run_app()
