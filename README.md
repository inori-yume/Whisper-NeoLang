# Whisper-HY-tool

基于 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 进行语音识别，再通过 [混元 MT 1.5-7B GPTQ-Int4](https://huggingface.co/Tencent-Hunyuan/HY-MT1.5-7B-GPTQ-Int4) 模型进行翻译，最终输出中文 SRT 字幕文件的本地全离线工具。

---

## 功能概览

| 脚本 | 功能 |
|---|---|
| `audio.py` | 加载 Whisper 模型，对音频文件做语音识别，输出 `transcription.json` |
| `translate.py` | 加载混元翻译模型，读取 JSON，逐条翻译并输出 `.srt` 字幕文件 |

---

## 环境要求

### Python 版本

推荐使用 **Python 3.11**。

- Python 3.12 在安装 `gptqmodel` 时需要 Visual Studio Build Tools，容易失败。
- Python 3.10 及以下未经测试。

### 显卡 / CUDA

| 显卡 | CUDA 驱动版本 | 推荐使用 |
|---|---|---|
| RTX 40 系 / 30 系（已升级驱动） | CUDA 12.x | `requirements.txt` |
| GTX 10 系 / 16 系 / 20 系 / 30 系（旧驱动） | CUDA 11.8 | `requirements-cuda118.txt` |

运行 `nvidia-smi` 查看右上角的 `CUDA Version` 来确认你的版本。

---

## 环境搭建

### 1. 推荐：使用 venv 虚拟环境

```powershell
# 在项目根目录新建虚拟环境
python -m venv .venv

# 激活（Windows PowerShell）
.\.venv\Scripts\Activate.ps1

# 激活（Windows CMD）
.\.venv\Scripts\activate.bat
```

> 也可以使用 `conda`，但 venv 更轻量，不需要额外安装。

### 2. 安装依赖

**CUDA 12.x：**
```powershell
pip install -r requirements.txt
```

**CUDA 11.8：**
```powershell
pip install -r requirements-cuda118.txt
```

> `gptqmodel` 需要关闭 `build-isolation` 才能正确安装。如果安装失败，尝试：
> ```powershell
> pip install gptqmodel==4.2.5 --no-build-isolation
> ```

---

## 模型准备

两个模型体积较大，**不包含在本仓库中**，需手动下载后放置到项目根目录。

### faster-whisper-large-v3（约 3 GB）

| 来源 | 地址 |
|---|---|
| Hugging Face | https://huggingface.co/Systran/faster-whisper-large-v3 |
| HF 镜像（国内） | https://hf-mirror.com/Systran/faster-whisper-large-v3 |
| ModelScope | https://modelscope.cn/models/Systran/faster-whisper-large-v3 |

### HY-MT1.5-7B-GPTQ-Int4（约 4.5 GB）

| 来源 | 地址 |
|---|---|
| Hugging Face | https://huggingface.co/Tencent-Hunyuan/HY-MT1.5-7B-GPTQ-Int4 |
| HF 镜像（国内） | https://hf-mirror.com/Tencent-Hunyuan/HY-MT1.5-7B-GPTQ-Int4 |
| ModelScope | https://modelscope.cn/models/Tencent-Hunyuan/HY-MT1.5-7B-GPTQ-Int4 |

### 下载方式

推荐使用 `huggingface_hub` 命令行工具：

```powershell
pip install huggingface_hub
huggingface-cli download Systran/faster-whisper-large-v3 --local-dir ./faster-whisper-large-v3
huggingface-cli download Tencent-Hunyuan/HY-MT1.5-7B-GPTQ-Int4 --local-dir ./HY-MT1.5-7B-GPTQ-Int4
```

国内网络建议先设置镜像端点：

```powershell
$env:HF_ENDPOINT = "https://hf-mirror.com"
huggingface-cli download Systran/faster-whisper-large-v3 --local-dir ./faster-whisper-large-v3
huggingface-cli download Tencent-Hunyuan/HY-MT1.5-7B-GPTQ-Int4 --local-dir ./HY-MT1.5-7B-GPTQ-Int4
```

---

## 使用步骤

### 第一步：准备音频文件

将待识别的音频文件（支持 `.mp3`、`.wav`、`.m4a` 等）放入项目根目录。

### 第二步：语音识别

打开 `audio.py`，修改**配置区**的两个变量：

```python
# --- 配置区 ---
audio_path = "your_audio.mp3"   # ← 改为你的音频文件名
output_json = "transcription.json"  # 输出的 JSON 文件名，一般不需要改
```

然后运行：

```powershell
python audio.py
```

识别结果会保存为 `transcription.json`。

### 第三步：翻译为中文字幕

打开 `translate.py`，按需修改**配置区**：

```python
# --- 1. 加载配置 ---
model_path = "./HY-MT1.5-7B-GPTQ-Int4"   # 模型路径，默认不需要改
input_json = "transcription.json"          # 第一步生成的 JSON
output_srt = "final_chinese_subtitles.srt" # 输出字幕文件名
```

然后运行：

```powershell
python translate.py
```

最终字幕文件为 `final_chinese_subtitles.srt`。

---

## 微调建议

### 调整识别语言 / 内容领域

在 `audio.py` 中修改 `model.transcribe()` 的参数：

```python
segments, info = model.transcribe(
    audio_path,
    language="pt",           # ← 改为源语言代码，如 "en"（英语）、"ja"（日语）、"pt"（葡语）
    initial_prompt="...",    # ← 填入领域关键词，帮助模型纠正专有名词拼写
    vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=500),  # ← 调整静音检测灵敏度
)
```

### 调整翻译风格 / 领域术语

在 `translate.py` 中修改术语干预列表和 Prompt：

```python
# 修改此列表来增减需要保留原文的术语
_CS2_TERM_HINT = "\n".join(f"{t} 翻译成 {t}" for t in [
    "Eco", "Rush", "AWP", ...  # ← 添加你领域的专有名词
])
```

同时可以调整生成参数来控制翻译质量：

```python
output_ids = model.generate(
    input_ids,
    max_new_tokens=256,       # 最大输出长度
    temperature=0.7,          # ↓ 更低 = 更保守/准确；↑ 更高 = 更多样/创意
    top_p=0.6,
    repetition_penalty=1.05,  # ↑ 更高 = 减少重复输出
)
```

### 切换 Whisper 模型大小

本项目默认使用 `faster-whisper-large-v3`（精度最高，需要约 3GB 显存）。
如显存不足，可以替换为较小的模型：

```python
model_path = "./faster-whisper-medium"   # 约 1.5GB 显存
model_path = "./faster-whisper-small"    # 约 500MB 显存
```

从 Hugging Face 下载对应模型后，修改 `audio.py` 中的 `model_path` 即可。

---

## 项目结构

```
.
├── audio.py                        # 语音识别脚本
├── translate.py                    # 翻译脚本
├── requirements.txt                # 依赖（CUDA 12.x）
├── requirements-cuda118.txt        # 依赖（CUDA 11.8）
├── transcription.json              # 识别结果（运行 audio.py 后生成）
├── final_chinese_subtitles.srt     # 中文字幕（运行 translate.py 后生成）
├── faster-whisper-large-v3/        # Whisper 本地模型（不含于仓库，见"模型准备"）
└── HY-MT1.5-7B-GPTQ-Int4/         # 混元翻译模型（不含于仓库，见"模型准备"）
```

---

## 常见问题

**Q: 运行时提示找不到 `cublas64_12.dll`？**  
A: `audio.py` 已内置 DLL 路径修复逻辑。若仍报错，请确认已通过 pip 安装了 `nvidia-cublas-cu12`（CUDA 12 版本会自动附带）。

**Q: `gptqmodel` 安装失败？**  
A: 用 `pip install gptqmodel==4.2.5 --no-build-isolation` 重试，Windows 上还需确保已安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)。

**Q: 翻译结果包含多余的解释文字？**  
A: 适当调低 `temperature`（如改为 `0.3`），并确认 Prompt 中有 "只需要输出翻译后的结果，不要额外解释" 的指令。
