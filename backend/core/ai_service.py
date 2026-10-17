import json
import os
import re
from typing import Any, Dict, List, Optional
import httpx
from fastapi import HTTPException
from backend.db import get_setting, set_setting

PROVIDERS = {
    'gemini': {
        'id': 'gemini',
        'name': 'Google Gemini',
        'badge': 'Gemini',
        'defaultModel': 'gemini-2.5-flash',
        'models': [
            {'id': 'gemini-2.5-flash', 'name': 'Gemini 2.5 Flash (Nhanh & Tối ưu nhất - Khuyên dùng)'},
            {'id': 'gemini-2.5-pro', 'name': 'Gemini 2.5 Pro (Thông minh vượt trội)'},
            {'id': 'gemini-1.5-flash', 'name': 'Gemini 1.5 Flash'},
            {'id': 'gemini-1.5-pro', 'name': 'Gemini 1.5 Pro'},
        ],
        'requiresKey': True,
        'keyPlaceholder': 'Dán Gemini API Key (AIzaSy...)',
        'keyHelpUrl': 'https://aistudio.google.com/app/apikey',
        'keyHelpText': 'Lấy API Key miễn phí tại Google AI Studio ↗',
        'defaultEndpoint': 'https://generativelanguage.googleapis.com/v1beta',
    },
    'openai': {
        'id': 'openai',
        'name': 'OpenAI (ChatGPT)',
        'badge': 'ChatGPT',
        'defaultModel': 'gpt-4o-mini',
        'models': [
            {'id': 'gpt-4o-mini', 'name': 'GPT-4o Mini (Nhanh, thông minh & siêu tiết kiệm)'},
            {'id': 'gpt-4o', 'name': 'GPT-4o (Mạnh nhất của OpenAI)'},
            {'id': 'o3-mini', 'name': 'o3-mini (Lập luận tư duy sâu)'},
            {'id': 'gpt-3.5-turbo', 'name': 'GPT-3.5 Turbo'},
        ],
        'requiresKey': True,
        'keyPlaceholder': 'Dán OpenAI API Key (sk-...)',
        'keyHelpUrl': 'https://platform.openai.com/api-keys',
        'keyHelpText': 'Lấy API Key tại OpenAI Platform ↗',
        'defaultEndpoint': 'https://api.openai.com/v1',
    },
    'deepseek': {
        'id': 'deepseek',
        'name': 'DeepSeek',
        'badge': 'DeepSeek',
        'defaultModel': 'deepseek-chat',
        'models': [
            {'id': 'deepseek-chat', 'name': 'DeepSeek-V3 Chat (Văn phong mượt mà, siêu rẻ)'},
            {'id': 'deepseek-reasoner', 'name': 'DeepSeek-R1 Reasoner (Tư duy lý luận mạnh)'},
        ],
        'requiresKey': True,
        'keyPlaceholder': 'Dán DeepSeek API Key (sk-...)',
        'keyHelpUrl': 'https://platform.deepseek.com/api_keys',
        'keyHelpText': 'Lấy API Key tại DeepSeek Platform ↗',
        'defaultEndpoint': 'https://api.deepseek.com',
    },
    'claude': {
        'id': 'claude',
        'name': 'Anthropic Claude',
        'badge': 'Claude',
        'defaultModel': 'claude-3-5-haiku-20241022',
        'models': [
            {'id': 'claude-3-5-haiku-20241022', 'name': 'Claude 3.5 Haiku (Siêu tốc & sắc sảo)'},
            {'id': 'claude-3-5-sonnet-20241022', 'name': 'Claude 3.5 Sonnet (Chất lượng văn phong đỉnh cao)'},
            {'id': 'claude-3-opus-20240229', 'name': 'Claude 3 Opus'},
        ],
        'requiresKey': True,
        'keyPlaceholder': 'Dán Anthropic API Key (sk-ant-...)',
        'keyHelpUrl': 'https://console.anthropic.com/settings/keys',
        'keyHelpText': 'Lấy API Key tại Anthropic Console ↗',
        'defaultEndpoint': 'https://api.anthropic.com/v1',
    },
    'custom': {
        'id': 'custom',
        'name': 'Tùy chỉnh / Ollama / Groq / OpenRouter',
        'badge': 'Custom / Local',
        'defaultModel': 'llama3',
        'models': [
            {'id': 'llama3', 'name': 'Llama 3 (Ollama/Groq)'},
            {'id': 'qwen2.5:7b', 'name': 'Qwen 2.5 (Ollama)'},
            {'id': 'mistral', 'name': 'Mistral (Ollama)'},
            {'id': 'deepseek-r1:7b', 'name': 'DeepSeek R1 Local (Ollama)'},
        ],
        'requiresKey': False,
        'keyPlaceholder': 'API Key (bỏ trống nếu dùng Ollama máy cá nhân)',
        'keyHelpUrl': 'https://ollama.com',
        'keyHelpText': 'Hỗ trợ Ollama (http://localhost:11434/v1), Groq, OpenRouter...',
        'defaultEndpoint': 'http://localhost:11434/v1',
    },
}

def mask_key(key: str) -> str:
    if not key:
        return ''
    s = str(key).strip()
    if len(s) <= 8:
        return '********'
    return f"{s[:6]}...{s[-4:]}"

def normalize_endpoint(raw: Optional[str]) -> str:
    if not raw:
        return ''
    ep = str(raw).strip()
    if not ep:
        return ''
    # Sửa các lỗi gõ nhầm dấu hai chấm / xuyệt như "localhost:/8080" hay "localhost::8080"
    ep = re.sub(r':/+([0-9]{2,5})', r':\1', ep)
    ep = re.sub(r'([^:/]):+([0-9]{2,5})', r'\1:\2', ep)
    # Bổ sung scheme http:// nếu người dùng quên nhập
    if not ep.startswith(('http://', 'https://')):
        ep = 'http://' + ep
    return ep.rstrip('/')

def get_provider_key(provider_id: str) -> str:
    pid = provider_id.lower()
    if pid == 'gemini':
        return str(get_setting('ai_gemini_key', '') or get_setting('gemini_api_key', '') or os.environ.get('GEMINI_API_KEY', '')).strip()
    elif pid == 'openai':
        return str(get_setting('ai_openai_key', '') or os.environ.get('OPENAI_API_KEY', '')).strip()
    elif pid == 'deepseek':
        return str(get_setting('ai_deepseek_key', '') or os.environ.get('DEEPSEEK_API_KEY', '')).strip()
    elif pid == 'claude':
        return str(get_setting('ai_claude_key', '') or os.environ.get('ANTHROPIC_API_KEY', '')).strip()
    elif pid == 'custom':
        return str(get_setting('ai_custom_key', '') or os.environ.get('CUSTOM_AI_API_KEY', '')).strip()
    return str(get_setting(f'ai_{pid}_key', '')).strip()

def get_provider_model(provider_id: str) -> str:
    pid = provider_id.lower()
    info = PROVIDERS.get(pid, {})
    default_m = info.get('defaultModel', '')
    if pid == 'gemini':
        return str(get_setting('ai_gemini_model', '') or get_setting('gemini_model', '') or default_m).strip()
    return str(get_setting(f'ai_{pid}_model', '') or default_m).strip()

def get_provider_endpoint(provider_id: str) -> str:
    pid = provider_id.lower()
    info = PROVIDERS.get(pid, {})
    default_ep = info.get('defaultEndpoint', '')
    return str(get_setting(f'ai_{pid}_endpoint', '') or default_ep).strip()

def get_all_ai_settings() -> dict:
    active_pid = str(get_setting('ai_active_provider', '') or 'gemini').lower()
    if active_pid not in PROVIDERS:
        active_pid = 'gemini'

    providers_list = []
    for pid, meta in PROVIDERS.items():
        key = get_provider_key(pid)
        model = get_provider_model(pid)
        endpoint = get_provider_endpoint(pid)
        providers_list.append({
            'id': pid,
            'name': meta['name'],
            'badge': meta['badge'],
            'hasKey': bool(key),
            'maskedKey': mask_key(key),
            'model': model,
            'endpoint': endpoint,
            'defaultEndpoint': meta.get('defaultEndpoint', ''),
            'models': meta.get('models', []),
            'requiresKey': meta.get('requiresKey', True),
            'keyPlaceholder': meta.get('keyPlaceholder', ''),
            'keyHelpUrl': meta.get('keyHelpUrl', ''),
            'keyHelpText': meta.get('keyHelpText', ''),
            'isActive': pid == active_pid,
        })

    active_key = get_provider_key(active_pid)
    active_model = get_provider_model(active_pid)
    active_endpoint = get_provider_endpoint(active_pid)
    persona_prompt = str(get_setting('ai_persona_prompt', '') or '').strip()

    return {
        'activeProvider': active_pid,
        'hasKey': bool(active_key) or not PROVIDERS[active_pid]['requiresKey'],
        'maskedKey': mask_key(active_key),
        'model': active_model,
        'endpoint': active_endpoint,
        'personaPrompt': persona_prompt,
        'providers': providers_list,
    }

def save_ai_settings(
    provider: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
    endpoint: Optional[str] = None,
    set_active: bool = True,
    persona_prompt: Optional[str] = None,
) -> dict:
    pid = (provider or get_setting('ai_active_provider', '') or 'gemini').lower()
    if pid not in PROVIDERS:
        pid = 'gemini'

    if set_active:
        set_setting('ai_active_provider', pid)

    if api_key is not None and str(api_key).strip():
        k = str(api_key).strip()
        set_setting(f'ai_{pid}_key', k)
        if pid == 'gemini':
            set_setting('gemini_api_key', k)

    if model is not None and str(model).strip():
        m = str(model).strip()
        set_setting(f'ai_{pid}_model', m)
        if pid == 'gemini':
            set_setting('gemini_model', m)

    if endpoint is not None:
        set_setting(f'ai_{pid}_endpoint', normalize_endpoint(endpoint))

    if persona_prompt is not None:
        set_setting('ai_persona_prompt', str(persona_prompt).strip())

    return get_all_ai_settings()

def _clean_and_parse_json(raw_text: str) -> dict:
    text = raw_text.strip()
    cleaned = re.sub(r'^```(?:json)?\s*', '', text, flags=re.I)
    cleaned = re.sub(r'\s*```$', '', cleaned, flags=re.I).strip()

    try:
        return json.loads(cleaned)
    except Exception:
        pass

    match = re.search(r'(\{[\s\S]*\})', text)
    if match:
        try:
            return json.loads(match.group(1))
        except Exception:
            pass

    return {
        'title': '',
        'caption': text,
        'hashtags': '',
        'variations': [],
    }

async def generate_content(
    provider_id: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
    endpoint: Optional[str] = None,
    mode: str = 'generate',
    topic: str = '',
    existing_content: str = '',
    platform: str = 'Facebook',
    tone: str = 'bán hàng thu hút',
    instructions: str = '',
    count: int = 1,
    persona_prompt: Optional[str] = None,
) -> dict:
    pid = (provider_id or get_setting('ai_active_provider', '') or 'gemini').lower()
    if pid not in PROVIDERS:
        pid = 'gemini'

    meta = PROVIDERS[pid]
    key = str(api_key or '').strip() or get_provider_key(pid)
    selected_model = str(model or '').strip() or get_provider_model(pid)
    selected_endpoint = str(endpoint or '').strip() or get_provider_endpoint(pid)

    if meta.get('requiresKey', True) and not key:
        raise HTTPException(
            status_code=400,
            detail=f"Chưa cấu hình API Key cho {meta['name']}. Vui lòng nhập API Key trên giao diện."
        )

    # Lấy phong cách cá nhân đã lưu hoặc được truyền vào
    saved_persona = str(get_setting('ai_persona_prompt', '') or '').strip()
    active_persona = (persona_prompt if persona_prompt is not None else saved_persona).strip()
    persona_rule = ""
    if active_persona:
        persona_rule = f"""

ĐẶC ĐIỂM & PHONG CÁCH CÁ NHÂN / THƯƠNG HIỆU CỦA TÁC GIẢ (BẮT BUỘC TUÂN THỦ):
\"\"\"
{active_persona}
\"\"\""""

    # Prepare prompt
    if mode == 'rewrite':
        if not existing_content:
            raise HTTPException(status_code=400, detail="Vui lòng nhập nội dung cần viết lại")
        system_instruction = "Bạn là chuyên gia biên tập và tối ưu nội dung mạng xã hội tiếng Việt."
        if active_persona:
            system_instruction += f" Hãy tuân thủ phong cách riêng của tác giả: {active_persona}"
        user_prompt = f"""Hãy viết lại bài viết sau đây theo phong cách: "{tone}".
Nền tảng hướng tới: {platform}.
Yêu cầu thêm: {instructions or 'Viết lại hấp dẫn hơn, thêm emoji phù hợp, ngắt dòng rõ ràng, bổ sung hashtag liên quan'}.{persona_rule}

NỘI DUNG GỐC:
\"\"\"
{existing_content}
\"\"\"

Yêu cầu định dạng đầu ra:
Bạn PHẢI trả về JSON hợp lệ theo đúng cấu trúc sau (không kèm lời dẫn, không giải thích bên ngoài JSON):
{{
  "title": "Tiêu đề ngắn gọn, bắt mắt (nếu phù hợp)",
  "caption": "Nội dung bài viết hoàn chỉnh đã được viết lại, ngắt dòng đẹp mắt và có emoji...",
  "hashtags": "#hashtag1 #hashtag2 #hashtag3",
  "variations": []
}}"""
    else:
        if not topic and not instructions:
            raise HTTPException(status_code=400, detail="Vui lòng nhập chủ đề hoặc ý tưởng bài viết")
        system_instruction = "Bạn là chuyên gia sáng tạo nội dung mạng xã hội tiếng Việt hàng đầu."
        if active_persona:
            system_instruction += f" Hãy tuân thủ phong cách riêng của tác giả: {active_persona}"
        user_prompt = f"""Hãy viết bài đăng cho nền tảng: "{platform}".
Chủ đề / Ý tưởng: "{topic}".
Giọng điệu / Phong cách: "{tone}".
Yêu cầu thêm: {instructions or 'Nội dung hấp dẫn, bắt trend, có lời kêu gọi hành động (CTA), chèn emoji sinh động'}.{persona_rule}
Số lượng bài viết cần tạo: {count}.

Yêu cầu định dạng đầu ra:
Bạn PHẢI trả về JSON hợp lệ theo đúng cấu trúc sau (không kèm lời dẫn, không giải thích bên ngoài JSON):
{{
  "title": "Tiêu đề bài viết ngắn gọn, giật tít, hấp dẫn",
  "caption": "Nội dung bài viết hoàn chỉnh, ngắt dòng đẹp mắt, có icon/emoji và lời kêu gọi hành động (CTA)...",
  "hashtags": "#hashtag1 #hashtag2 #hashtag3",
  "variations": [
    {'''
    {
      "title": "Tiêu đề biến thể...",
      "caption": "Nội dung biến thể...",
      "hashtags": "#hashtag1 #hashtag2"
    }''' if count > 1 else ''}
  ]
}}"""

    async with httpx.AsyncClient(timeout=60.0) as client:
        if pid == 'gemini':
            raw_text = await _call_gemini(client, key, selected_model, selected_endpoint, f"{system_instruction}\n\n{user_prompt}")
        elif pid in ('openai', 'deepseek', 'custom'):
            raw_text = await _call_openai_compatible(client, pid, key, selected_model, selected_endpoint, system_instruction, user_prompt)
        elif pid == 'claude':
            raw_text = await _call_claude(client, key, selected_model, selected_endpoint, system_instruction, user_prompt)
        else:
            raise HTTPException(status_code=400, detail=f"Nhà cung cấp {pid} chưa được hỗ trợ.")

    parsed = _clean_and_parse_json(raw_text)
    return {
        'ok': True,
        'provider': pid,
        'model': selected_model,
        'result': {
            'title': parsed.get('title') or '',
            'caption': parsed.get('caption') or '',
            'hashtags': parsed.get('hashtags') or '',
            'variations': parsed.get('variations') if isinstance(parsed.get('variations'), list) else [],
        }
    }

async def _call_gemini(client: httpx.AsyncClient, api_key: str, model: str, endpoint: str, prompt: str) -> str:
    url = f"{endpoint.rstrip('/')}/models/{model}:generateContent?key={api_key}"
    payload = {
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {
            'temperature': 0.7,
            'responseMimeType': 'application/json',
        }
    }
    try:
        resp = await client.post(url, json=payload, headers={'Content-Type': 'application/json'})
        if resp.status_code != 200:
            try:
                err_data = resp.json()
                msg = err_data.get('error', {}).get('message') or resp.text
            except Exception:
                msg = resp.text
            raise HTTPException(status_code=400, detail=f"Google Gemini lỗi ({resp.status_code}): {msg}")

        data = resp.json()
        return data['candidates'][0]['content']['parts'][0]['text']
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Kết nối Google Gemini thất bại: {str(e)}")

async def _call_openai_compatible(
    client: httpx.AsyncClient,
    provider_id: str,
    api_key: str,
    model: str,
    endpoint: str,
    system_prompt: str,
    user_prompt: str
) -> str:
    ep = normalize_endpoint(endpoint)
    if not ep.endswith('/chat/completions'):
        url = f"{ep}/chat/completions"
    else:
        url = ep

    headers = {'Content-Type': 'application/json'}
    if api_key:
        headers['Authorization'] = f"Bearer {api_key}"

    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': user_prompt},
        ],
        'temperature': 0.7,
    }

    try:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code != 200:
            provider_name = PROVIDERS.get(provider_id, {}).get('name', provider_id)
            try:
                err_data = resp.json()
                msg = err_data.get('error', {}).get('message') or resp.text
            except Exception:
                msg = resp.text
            raise HTTPException(status_code=400, detail=f"{provider_name} lỗi ({resp.status_code}): {msg}")

        data = resp.json()
        return data['choices'][0]['message']['content']
    except HTTPException:
        raise
    except Exception as e:
        provider_name = PROVIDERS.get(provider_id, {}).get('name', provider_id)
        raise HTTPException(status_code=400, detail=f"Kết nối {provider_name} thất bại: {str(e)}")

async def _call_claude(
    client: httpx.AsyncClient,
    api_key: str,
    model: str,
    endpoint: str,
    system_prompt: str,
    user_prompt: str
) -> str:
    ep = endpoint.rstrip('/')
    if not ep.endswith('/messages'):
        url = f"{ep}/messages"
    else:
        url = ep

    headers = {
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
    }
    payload = {
        'model': model,
        'max_tokens': 4096,
        'system': system_prompt,
        'messages': [
            {'role': 'user', 'content': user_prompt}
        ]
    }

    try:
        resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code != 200:
            try:
                err_data = resp.json()
                msg = err_data.get('error', {}).get('message') or resp.text
            except Exception:
                msg = resp.text
            raise HTTPException(status_code=400, detail=f"Anthropic Claude lỗi ({resp.status_code}): {msg}")

        data = resp.json()
        return data['content'][0]['text']
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Kết nối Anthropic Claude thất bại: {str(e)}")
