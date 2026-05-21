# Whisper-HY-tool

基于 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 进行语音识别，再通过本地 [混元 MT 模型](https://huggingface.co/Tencent-Hunyuan/HY-MT1.5-7B-GPTQ-Int4) 或 [硅基流动 API](https://cloud.siliconflow.cn) 进行翻译，最终输出中文 SRT 字幕文件的本地全离线工具。

当前项目同时提供：

- 命令行脚本模式：`audio.py` + `translate.py`
- 本地 Web 界面模式：`web_gui.py`（**推荐**）

---

## 功能概览

| 脚本 | 功能 |
|---|---|
| `audio.py` | 加载 Whisper 模型，对音频文件做语音识别，输出 `transcription.json` |
| `translate.py` | 加载混元翻译模型，读取 JSON，逐条翻译并输出 `.srt` 字幕文件 |
| `web_gui.py` | 提供本地 Web 界面，支持识别、翻译、配置管理、模型下载等全部功能 |

---

## 运行模式

### CLI 模式

适合直接跑脚本、做批处理，输出流程清晰：

1. `audio.py` 生成 `transcription.json`
2. `translate.py` 读取 JSON 并生成 `final_chinese_subtitles.srt`

### Web UI 模式

适合日常使用，启动后浏览器自动打开本地页面：

```powershell
python web_gui.py
```

**界面功能一览：**

| 功能模块 | 说明 |
|---|---|
| 语音识别 (ASR) | 自动扫描项目目录内的 Whisper 模型；支持 GPU / CPU 模式切换；可选识别语言 |
| 翻译 | 支持本地混元模型与硅基流动 API 两种引擎；读取 JSON 文件逐句翻译 |
| 运行日志 | ASR 实时显示 `[当前时间 / 总时长] 识别文字`；翻译实时显示 `[第n句/总句数] 译文` |
| 结果预览 | 原文 / 译文对照表格展示 |
| 模型路径 | 导航栏配置 Whisper 和混元模型路径，自动记住设置 |
| 硅基流动 API | 导航栏配置 API Key 和模型（Hunyuan-MT-7B 免费；A13B 收费需二次确认） |
| 术语表 | 注入翻译 Prompt 的专有名词映射表，支持增删 |
| Prompt 模板 | 可自定义翻译指令模板，支持 `{terms}` 和 `{text}` 变量 |
| 环境自检 | 一键检测 CUDA 版本、虚拟环境、所有依赖组件和本地模型情况 |
| 下载模型 | 内置 Whisper 模型下载器，默认使用 `hf-mirror.com` 镜像，实时显示速度和进度 |

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

两个依赖文件均包含：

- 推理核心依赖：`torch`、`transformers`、`gptqmodel`、`accelerate`、`optimum`
- 语音识别依赖：`faster-whisper`
- Web 界面依赖：`Flask`、`Flask-SocketIO`、`simple-websocket`

> `gptqmodel` 需要关闭 `build-isolation` 才能正确安装。如果安装失败，尝试：
> ```powershell
> pip install gptqmodel==4.2.5 --no-build-isolation
> ```

---

## 模型准备

模型体积较大，**不包含在本仓库中**，需手动下载后放置到项目根目录。

> **推荐方式：** 启动 `web_gui.py` 后，点击导航栏的「**下载模型**」按钮，可在页面内直接下载所有 Whisper 模型（默认使用 `hf-mirror.com` 镜像，实时显示进度和速度）。

### Whisper 语音识别模型

支持以下多种规格（项目会自动扫描目录内已有的模型）：

| 模型 | 大小 | Hugging Face |
|---|---|---|
| faster-whisper-tiny | ~75 MB | [Systran/faster-whisper-tiny](https://huggingface.co/Systran/faster-whisper-tiny) |
| faster-whisper-base | ~145 MB | [Systran/faster-whisper-base](https://huggingface.co/Systran/faster-whisper-base) |
| faster-whisper-small | ~488 MB | [Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small) |
| faster-whisper-medium | ~1.5 GB | [Systran/faster-whisper-medium](https://huggingface.co/Systran/faster-whisper-medium) |
| faster-whisper-large-v2 | ~3.0 GB | [Systran/faster-whisper-large-v2](https://huggingface.co/Systran/faster-whisper-large-v2) |
| faster-whisper-large-v3 | ~3.1 GB | [Systran/faster-whisper-large-v3](https://huggingface.co/Systran/faster-whisper-large-v3) |

### HY-MT1.5-7B-GPTQ-Int4（本地翻译模型，约 4.5 GB）

使用本地翻译模式时需要此模型；若选择硅基流动 API 模式则不需要。

| 来源 | 地址 |
|---|---|
| Hugging Face | https://huggingface.co/Tencent-Hunyuan/HY-MT1.5-7B-GPTQ-Int4 |
| HF 镜像（国内） | https://hf-mirror.com/Tencent-Hunyuan/HY-MT1.5-7B-GPTQ-Int4 |
| ModelScope | https://modelscope.cn/models/Tencent-Hunyuan/HY-MT1.5-7B-GPTQ-Int4 |

### 命令行手动下载（可选）

```powershell
pip install huggingface_hub

# 设置国内镜像（可选）
$env:HF_ENDPOINT = "https://hf-mirror.com"

huggingface-cli download Systran/faster-whisper-large-v3 --local-dir ./faster-whisper-large-v3
huggingface-cli download Tencent-Hunyuan/HY-MT1.5-7B-GPTQ-Int4 --local-dir ./HY-MT1.5-7B-GPTQ-Int4
```

---

## 使用步骤

### 方式一：Web 界面（推荐）

```powershell
python web_gui.py
```

**首次使用流程：**

1. 点击导航栏「**下载模型**」下载所需的 Whisper 模型
2. 点击导航栏「**模型路径**」配置 Whisper 模型目录（也可在语音识别面板下拉选择），以及混元翻译模型路径
3. 如使用 API 翻译，点击导航栏「**硅基流动 API**」填写 Key 并选择模型
4. 在「语音识别」面板选择音频文件，点击「开始语音识别」
5. 识别完成后，在「翻译」面板选择生成的 JSON 文件，点击「翻译 JSON 字幕」
6. 右侧结果预览查看原文 / 译文对照，字幕文件保存为 `final_chinese_subtitles.srt`

> 所有配置（模型路径、语言、设备模式、API Key 等）会自动记录在浏览器本地存储中，下次打开无需重新设置。

### 方式二：命令行脚本

#### 第一步：语音识别

打开 `audio.py`，修改**配置区**：

```python
# --- 配置区 ---
audio_path = "your_audio.mp3"       # ← 改为你的音频文件名
output_json = "transcription.json"  # 输出的 JSON 文件名
```

然后运行：

```powershell
python audio.py
```

识别结果保存为 `transcription.json`。

#### 第二步：翻译为中文字幕

打开 `translate.py`，按需修改**配置区**：

```python
# --- 1. 加载配置 ---
model_path = "./HY-MT1.5-7B-GPTQ-Int4"    # 模型路径
input_json = "transcription.json"           # 第一步生成的 JSON
output_srt = "final_chinese_subtitles.srt"  # 输出字幕文件名
```

然后运行：

```powershell
python translate.py
```

最终字幕文件为 `final_chinese_subtitles.srt`。

---

## 微调建议

### 调整识别语言 / 内容领域

在 `audio.py` 中修改 `model.transcribe()` 的参数（Web UI 中也可直接在下拉菜单切换）：

```python
segments, info = model.transcribe(
    audio_path,
    language="pt",           # ← 源语言代码，如 "en"（英语）、"ja"（日语）、"pt"（葡语）
    initial_prompt="...",    # ← 填入领域关键词，帮助模型纠正专有名词拼写
    vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=500),
)
```

### 调整翻译风格 / 领域术语

术语表和 Prompt 模板存储在 `translate_config.json`，`translate.py` 和 `web_gui.py` 共用：

```json
{
    "terminology": [
        {"source": "Eco", "target": "Eco"},
        {"source": "Rush", "target": "Rush"}
    ],
    "prompt_template": "参考下面的翻译：\n{terms}\n\n将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n{text}"
}
```

推荐在 Web UI 的「术语表」和「Prompt」弹窗中直接编辑并保存。

### 选择 Whisper 模型规格

Web UI 会自动扫描并列出项目目录下所有 Whisper 模型（含 `vocabulary.json` 的文件夹），直接下拉选择即可。

显存参考：

| 模型 | 显存占用 |
|---|---|
| tiny / base | < 500 MB |
| small | ~500 MB |
| medium | ~1.5 GB |
| large-v2 / large-v3 | ~3 GB |

---

## 项目结构

```
.
├── audio.py                        # 语音识别脚本（CLI）
├── translate.py                    # 翻译脚本（CLI）
├── web_gui.py                      # 本地 Web UI 后端
├── requirements.txt                # 依赖（CUDA 12.x）
├── requirements-cuda118.txt        # 依赖（CUDA 11.8）
├── translate_config.json           # 共享翻译配置（术语表 / Prompt 模板）
├── web_config.json                 # Web UI 配置（模型路径 / 语言 / 翻译模式等）
├── transcription.json              # 识别结果（运行识别后生成）
├── final_chinese_subtitles.srt     # 中文字幕（运行翻译后生成）
├── templates/
│   └── index.html                  # Web 页面模板
├── static/
│   ├── app.js                      # 前端交互脚本
│   └── style.css                   # 页面样式
├── faster-whisper-large-v3/        # Whisper 本地模型（不含于仓库，见"模型准备"）
└── HY-MT1.5-7B-GPTQ-Int4/          # 混元翻译模型（不含于仓库，见"模型准备"）
```

---

## 常见问题

**Q: 运行时提示找不到 `cublas64_12.dll`？**  
A: `audio.py` 已内置 DLL 路径修复逻辑。若仍报错，请确认已通过 pip 安装了 `nvidia-cublas-cu12`（CUDA 12 版本会自动附带）。

**Q: `gptqmodel` 安装失败？**  
A: 用 `pip install gptqmodel==4.2.5 --no-build-isolation` 重试。Windows 上还需确保已安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)。

**Q: 翻译结果包含多余的解释文字？**  
A: 适当调低 `temperature`（如改为 `0.3`），并确认 Prompt 中有"只需要输出翻译后的结果，不要额外解释"的指令。

**Q: 使用硅基流动 API 需要什么条件？**  
A: 需要在 [硅基流动控制台](https://cloud.siliconflow.cn) 注册账号并获取 API Key。`Hunyuan-MT-7B` 模型免费调用；`Hunyuan-A13B-Instruct` 为收费模型，选择时会弹出二次确认。

**Q: 模型下载很慢？**  
A: 在「下载模型」弹窗顶部可修改镜像源地址。默认使用 `https://hf-mirror.com`，进度条右侧会实时显示下载速度。如发现被重定向，日志里会显示实际的 CDN 地址。

**Q: 页面里的术语表和命令行翻译结果不一致？**  
A: 两者共用 `translate_config.json`。如果在页面修改了设置但结果没变化，确认保存成功后再重新发起翻译任务。

**Q: Web 页面打不开或按钮没有响应？**  
A: 先确认已安装 `Flask`、`Flask-SocketIO`、`simple-websocket`，并使用 `python web_gui.py` 启动，而不是直接双击 HTML 文件。可使用导航栏「**环境自检**」按钮快速诊断缺失的依赖。

