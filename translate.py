import json
import torch
import os
import sys
import gc

# 解决 Windows 环境下 OpenMP 多实例冲突
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

# Windows 上 Triton 不可用，禁用 torch.compile / Inductor 后端，
# 防止 GPTQ 量化层在推理时触发 JIT 编译并崩溃
import torch._dynamo
torch._dynamo.config.suppress_errors = True
os.environ["TORCHINDUCTOR_DISABLE"] = "1"
import logging
logging.getLogger("torch._dynamo").setLevel(logging.CRITICAL)

from transformers import AutoModelForCausalLM, AutoTokenizer

# --- 配置 ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL_PATH = "./HY-MT1.5-7B-GPTQ-Int4"
input_json = "transcription.json"
output_srt = "final_chinese_subtitles.srt"

def _resolve_model_path() -> str:
    """优先读取 web_config.json 中前端保存的 hy_path，未配置时回退默认值。"""
    web_cfg = os.path.join(BASE_DIR, "web_config.json")
    if os.path.exists(web_cfg):
        try:
            with open(web_cfg, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            hy_path = (cfg.get("hy_path") or "").strip()
            if hy_path:
                return hy_path
        except Exception:
            pass
    return DEFAULT_MODEL_PATH

model_path = _resolve_model_path()

print(f"正在加载模型: {model_path}")

# 使用 slow tokenizer 以确保与自定义 chat_template 的兼容性
tokenizer = AutoTokenizer.from_pretrained(
    model_path,
    use_fast=False,
    trust_remote_code=True
)

try:
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        device_map="auto",
        dtype=torch.float16,
        trust_remote_code=True,
        low_cpu_mem_usage=True
    )
except Exception as e:
    print(f"模型加载失败: {e}")
    print("请确认已安装 gptqmodel，并使用 Python 3.11 + torch 2.7+ 环境运行。")
    print("若显存不足，可改用 HY-MT1.5-1.8B-GPTQ-Int4 版本。")
    sys.exit(1)

# 默认 CS2 专有术语映射表（当 translate_config.json 不存在时使用）
_DEFAULT_TERMINOLOGY = [
    {"source": t, "target": t} for t in [
        "Eco", "Rush", "Save", "Major", "Site", "CT", "T",
        "Nuke", "Dust2", "Inferno", "Mirage", "Overpass", "Ancient", "Anubis",
        "AWP", "AK", "M4", "Deagle", "Molotov", "Flash", "Smoke",
    ]
]
_DEFAULT_PROMPT_TEMPLATE = (
    "参考下面的翻译：\n{terms}\n\n"
    "将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n{text}"
)

def _load_translate_config() -> dict:
    """从 translate_config.json 读取术语表和 Prompt 模板，文件不存在时返回空字典。"""
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "translate_config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def translate_line(text):
    cfg = _load_translate_config()
    terminology = cfg.get('terminology', _DEFAULT_TERMINOLOGY)
    prompt_template = cfg.get('prompt_template', _DEFAULT_PROMPT_TEMPLATE)

    terms_text = "\n".join(f"{t['source']} 翻译成 {t['target']}" for t in terminology)
    prompt_content = prompt_template.format(terms=terms_text, text=text)
    messages = [{"role": "user", "content": prompt_content}]

    input_ids = tokenizer.apply_chat_template(
        messages,
        tokenize=True,
        add_generation_prompt=True,
        return_tensors="pt"
    ).to("cuda")

    with torch.no_grad():
        output_ids = model.generate(
            input_ids,
            max_new_tokens=256,
            top_k=20,
            top_p=0.6,
            temperature=0.7,
            repetition_penalty=1.05,
            do_sample=True
        )

    # 仅解码新生成的 token，跳过 prompt 部分
    response = tokenizer.decode(output_ids[0][input_ids.shape[1]:], skip_special_tokens=True)
    return response.strip()

def format_srt_time(seconds):
    ms = int((seconds - int(seconds)) * 1000)
    h, r = divmod(int(seconds), 3600)
    m, s = divmod(r, 60)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"

if __name__ == "__main__":
    if not os.path.exists(input_json):
        print(f"找不到识别文件: {input_json}")
        sys.exit(1)

    with open(input_json, "r", encoding="utf-8") as f:
        transcription_data = json.load(f)

    print(f"开始翻译，共 {len(transcription_data)} 条字幕...")

    with open(output_srt, "w", encoding="utf-8") as srt_file:
        for i, item in enumerate(transcription_data):
            original_text = item['text'].strip()
            if not original_text:
                continue

            translated_text = translate_line(original_text)

            start_time = format_srt_time(item['start'])
            end_time = format_srt_time(item['end'])

            srt_file.write(f"{i+1}\n")
            srt_file.write(f"{start_time} --> {end_time}\n")
            srt_file.write(f"{translated_text}\n\n")

            if (i + 1) % 5 == 0:
                print(f"进度: {i+1}/{len(transcription_data)}")

    print(f"翻译完成，字幕已保存至: {output_srt}")

    del model
    torch.cuda.empty_cache()
    gc.collect()