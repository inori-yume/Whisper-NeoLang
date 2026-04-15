import os
import sys
import json
import torch
import gc
from tqdm import tqdm

# Windows: 将 NVIDIA 包附带的 CUDA 运行时 DLL 目录注册到 PATH，
# 以确保 ctranslate2 能正确加载 cublas64_12.dll 等依赖库
venv_path = sys.prefix
nvidia_libs = os.path.join(venv_path, "Lib", "site-packages", "nvidia")
if os.path.exists(nvidia_libs):
    for root, dirs, files in os.walk(nvidia_libs):
        if 'bin' in dirs:
            os.environ["PATH"] += os.pathsep + os.path.join(root, 'bin')

# Python 3.8+ 在 Windows 上不会自动搜索 PATH 中的 DLL，需显式注册
if sys.platform == 'win32':
    for path in os.environ.get('PATH', '').split(os.pathsep):
        if os.path.exists(path) and 'nvidia' in path.lower() and 'bin' in path.lower():
            try:
                os.add_dll_directory(path)
            except Exception:
                pass

from faster_whisper import WhisperModel

# --- 配置 ---
audio_path = "test_video.mp3"
output_json = "transcription.json"
model_path = "./faster-whisper-large-v3"

print(f"正在从本地加载 Whisper 模型: {model_path}")
try:
    model = WhisperModel(
        model_path,
        device="cuda",
        compute_type="float16",
        local_files_only=True
    )
except Exception as e:
    print(f"模型加载失败: {e}")
    sys.exit(1)

print("模型加载成功，开始语音识别...")

segments, info = model.transcribe(
    audio_path,
    language="pt",
    vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=500),
    # 提供领域关键词，提升 CS2 专有名词的识别准确率
    initial_prompt="Counter-Strike 2, CS2, Major, Brazil, esports, FalleN, fer, fnx, coldzera, taco, gaules"
)

total_duration = info.duration
results = []

with tqdm(total=total_duration, unit="sec", desc="识别进度", bar_format="{l_bar}{bar}| {n:.1f}/{total:.1f}s [{elapsed}<{remaining}]") as pbar:
    for s in segments:
        results.append({"start": s.start, "end": s.end, "text": s.text})
        pbar.update(s.end - pbar.n)

with open(output_json, "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

print(f"识别完成，共 {len(results)} 条，结果已保存至 {output_json}")

del model
gc.collect()
torch.cuda.empty_cache()
print("ASR 模型显存已释放")