/*
 * 제미나이(Google Gemini API) 연결
 * - API 키는 사용자가 설정 화면에서 직접 입력하고, 이 기기 브라우저(localStorage)에만 저장한다.
 * - 키는 URL이 아니라 x-goog-api-key 헤더로 보낸다.
 * - 무료 등급 모델 목록은 바뀌므로 하드코딩하지 않고, 키로 모델 목록을 받아 Flash 계열을 고른다.
 */
const Gemini = (() => {
  const KEY = 'sit.gemini';
  const BASE = 'https://generativelanguage.googleapis.com/v1beta';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function save(cfg) {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* 저장 불가 */ }
  }
  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) { /* 무시 */ }
  }
  const ready = () => { const c = load(); return !!(c.key && c.model); };

  // 실패 원인을 코드로 정리 (화면 문구는 app.js에서 정한다)
  function toError(status, body) {
    const msg = (body && body.error && body.error.message) || '';
    const reason = JSON.stringify(body || {});
    if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(reason + msg)) return { code: 'invalid_key', message: msg };
    if (status === 401 || status === 403) return { code: 'invalid_key', message: msg };
    if (status === 429) return { code: 'rate_limited', message: msg };
    if (status === 404) return { code: 'model_missing', message: msg };
    if (status === 400) return { code: 'bad_request', message: msg };
    return { code: 'upstream_error', message: msg || `HTTP ${status}` };
  }

  async function request(path, key, init = {}) {
    let res;
    try {
      res = await fetch(`${BASE}/${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, ...(init.headers || {}) },
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw { code: 'cancelled' };
      throw { code: 'network', message: String(e && e.message) };
    }
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch (e) { /* 본문 없음 */ }
      throw toError(res.status, body);
    }
    return res;
  }

  // 텍스트 생성이 되는 모델 목록. 가볍고 무료 한도가 넉넉한 Flash-Lite → Flash 순으로 정렬
  async function listModels(key) {
    const res = await request('models?pageSize=200', key);
    const data = await res.json();
    const skip = /(image|tts|audio|live|embedding|vision|thinking-exp|learnlm|aqa|veo|imagen)/i;
    const models = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
      .filter((m) => /gemini/i.test(m.id) && !skip.test(m.id));
    const rank = (id) => {
      let r = /flash-lite/i.test(id) ? 0 : /flash/i.test(id) ? 1 : /pro/i.test(id) ? 3 : 2;
      if (/preview|exp/i.test(id)) r += 0.5;     // 정식 버전 우선
      if (/latest/i.test(id)) r -= 0.2;
      return r;
    };
    // 버전 숫자가 큰 모델을 같은 계열 안에서 먼저
    const ver = (id) => parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    return models.sort((a, b) => rank(a.id) - rank(b.id) || ver(b.id) - ver(a.id));
  }

  /*
   * 답변을 스트리밍으로 받는다.
   * turns: [{role:'user'|'assistant', content}] (마지막은 user)
   * onText({text}) 로 지금까지의 전체 답변을 넘겨 준다. 끝나면 { text, truncated } 반환.
   */
  async function stream({ system, turns, signal, onText }) {
    const { key, model } = load();
    if (!key || !model) throw { code: 'no_key' };
    const res = await request(`models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, key, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] })),
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
      }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let finish = '';
    let blocked = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          let chunk;
          try { chunk = JSON.parse(line.slice(5)); } catch (e) { continue; }
          if (chunk.promptFeedback && chunk.promptFeedback.blockReason) blocked = true;
          const cand = (chunk.candidates || [])[0];
          if (!cand) continue;
          if (cand.finishReason) finish = cand.finishReason;
          const parts = (cand.content && cand.content.parts) || [];
          const add = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
          if (add) { text += add; if (onText) onText({ text }); }
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') throw { code: 'cancelled', text };
      throw { code: 'network', text };
    }
    if (blocked || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') throw { code: 'refused' };
    if (!text.trim()) throw { code: 'empty_completion' };
    return { text, truncated: finish === 'MAX_TOKENS' };
  }

  return { load, save, clear, ready, listModels, stream };
})();
