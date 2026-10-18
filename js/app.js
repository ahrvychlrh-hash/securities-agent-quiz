(() => {
  const { TYPES, make, makeCalc, canBlank, shuffle, pick, esc } = Engine;
  const ALL_TYPES = Object.keys(TYPES);
  let cert = null; // 지금 공부 중인 자격증 (CERTS 항목: subjects·chapters·pass·items·facts)
  const KEY = 'sit.v1';
  const SESSION_SIZE = 10;
  const $app = document.getElementById('app');

  // ───────── 저장소 (이 기기 브라우저에만 저장) ─────────
  // facts[id] = { n: 푼 횟수, ok: 맞힌 횟수, streak: 연속 정답, wrong: 오답노트 여부 }
  const db = load();

  function load() {
    const d = { facts: {}, types: ALL_TYPES.slice() };
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s) Object.assign(d, s);
    } catch (e) { /* 저장소 사용 불가 시 기본값 */ }
    d.types = d.types.filter((t) => TYPES[t]);
    if (!d.types.length) d.types = ALL_TYPES.slice();
    return d;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* 무시 */ }
  }
  const stat = (id) => db.facts[id] || (db.facts[id] = { n: 0, ok: 0, streak: 0, wrong: false });
  const wrongFacts = () => cert.items.filter((f) => db.facts[f.id] && db.facts[f.id].wrong);
  // 선택한 유형에 맞는 출제 대상 (계산형을 끄면 계산 문항 제외, 계산형만 켜면 계산 문항만)
  const eligible = (items) => items.filter((f) => (f.gen
    ? db.types.includes('calc')
    : db.types.some((t) => t !== 'calc')));
  const subjectOf = (id) => cert.subjects.find((s) => s.id === id);
  const chapterName = (c) => c.name || c.t;
  const chapterItems = (c) => cert.items.filter((f) => f.s === c.s && f.t === c.t);
  const isMastered = (f) => { const st = db.facts[f.id]; return !!(st && st.ok && !st.wrong); };
  const masteryPct = (fs) => (fs.length ? Math.round((fs.filter(isMastered).length / fs.length) * 100) : 0);
  const cutoff = (s) => Math.ceil(s.items * cert.pass.subject); // 과목별 과락 면제에 필요한 정답 수
  const pctText = (r) => `${Math.round(r * 100)}%`;

  function record(fact, ok) {
    const s = stat(fact.id);
    s.n += 1;
    if (ok) {
      s.ok += 1;
      s.streak += 1;
      if (s.streak >= 2) s.wrong = false; // 연속 2번 맞히면 오답노트에서 졸업
    } else {
      s.streak = 0;
      s.wrong = true;
    }
    save();
  }

  // ───────── 출제 ─────────
  // 처음 보는 개념과 오답노트 개념이 더 자주 나오도록 가중치 추출
  function weightedSample(facts, n) {
    const pool = facts.map((f) => {
      const s = db.facts[f.id];
      let w = 1;
      if (!s || !s.n) w += 1.5;
      if (s && s.wrong) w += 3;
      return { f, w };
    });
    const out = [];
    while (out.length < n && pool.length) {
      const total = pool.reduce((a, b) => a + b.w, 0);
      let r = Math.random() * total;
      let i = 0;
      while (i < pool.length - 1 && (r -= pool[i].w) > 0) i++;
      out.push(pool.splice(i, 1)[0].f);
    }
    return out;
  }

  // avoid: { factId: 직전 유형 } — 같은 개념을 다른 유형으로 다시 낼 때 사용
  // 같은 세션에서 한 개념이 여러 번 나오면 매번 다른 유형으로 낸다
  function buildQuestions(facts, avoid) {
    const used = {};
    return facts.map((f) => {
      if (f.gen) return makeCalc(f);
      // 빈칸형은 4지선다가 되는 개념에만, 고를 유형이 없으면 '옳은 것 고르기'로
      const base = db.types.filter((t) => t !== 'calc' && (t !== 'blank' || canBlank(f)));
      let types = base.length ? base : ['pickTrue'];
      const skip = new Set(used[f.id] || []);
      if (avoid && avoid[f.id]) skip.add(avoid[f.id]);
      const fresh = types.filter((t) => !skip.has(t));
      if (fresh.length) types = fresh;
      const type = pick(types);
      (used[f.id] = used[f.id] || []).push(type);
      return make(f, type, cert.facts.filter((x) => x.s === f.s));
    });
  }

  const MIN_SESSION = 5;
  let view = 'home';
  let session = null;
  let chapter = null;      // 지금 보고 있는 챕터 (cert.chapters 항목)
  let studyExamples = {};  // 개념 공부 화면의 계산 예시 (화면을 다시 그려도 숫자가 바뀌지 않게 보관)

  // opts.scope: { s } 과목 범위가 있으면 결과 화면에서 합격 기준과 비교한다
  // opts.back: 그만 풀기·결과 후 돌아갈 화면
  function startSession(title, facts, opts = {}) {
    let chosen = opts.keepAll ? shuffle(facts) : weightedSample(eligible(facts), SESSION_SIZE);
    if (!chosen.length) return;
    // 개념이 적은 챕터는 같은 개념을 다른 유형으로 반복해 최소 문항 수를 채운다
    if (!opts.keepAll && chosen.length < MIN_SESSION) {
      const base = chosen.slice();
      while (chosen.length < Math.min(MIN_SESSION, base.length * 3)) chosen = chosen.concat(shuffle(base));
      chosen = chosen.slice(0, Math.min(MIN_SESSION, base.length * 3));
    }
    session = {
      title, qs: buildQuestions(chosen, opts.avoid), i: 0, picked: [],
      scope: opts.scope || null, back: opts.back || 'cert', kind: opts.kind || 'mixed',
    };
    go('quiz');
  }

  // ───────── AI 튜터 ─────────
  // 웹사이트에서는 제미나이(설정에서 내 API 키 입력), claude.ai Artifact에서는 Claude(sample 기능)를 쓴다
  let sample = null;
  const IN_CLAUDE = !!(window.claude && typeof window.claude.use === 'function');
  const aiProvider = () => (sample ? 'claude' : !IN_CLAUDE && Gemini.ready() ? 'gemini' : null);
  if (IN_CLAUDE) {
    window.claude.use('sample')
      .then((fn) => { sample = fn; if (fn && view === 'quiz') renderAI(); })
      .catch(() => {});
  }
  const AI_SUGGEST = ['왜 이게 정답이에요?', '더 쉽게 설명해 줘', '헷갈리는 개념이랑 비교해 줘', '외우는 팁 알려 줘'];
  const AI_BLOCKING = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'];
  const plainText = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent.replace(/\s+/g, ' ').trim();
  };
  const chatFor = () => {
    session.chats = session.chats || {};
    return session.chats[session.i] || (session.chats[session.i] = { turns: [], busy: false, note: '' });
  };

  // 방금 푼 문제를 AI가 그대로 볼 수 있도록 글로 정리
  function questionContext(q, picked) {
    const lines = [
      `[과목 / 챕터] ${subjectOf(q.fact.s).name} / ${q.fact.t}`,
      `[문제 유형] ${TYPES[q.type].label}`,
      `[문제] ${q.prompt}`,
    ];
    if (q.stem) lines.push(`[지문] ${plainText(q.stem.replace(/<span class="blank"[^>]*><\/span>/, ' (빈칸) '))}`);
    q.choices.forEach((c, i) => {
      const label = `보기 ${i + 1}: ${plainText(c.html)}`;
      lines.push(`${label}${c.correct ? '  (정답)' : ''}${i === picked ? '  ← 학습자가 고른 답' : ''}`);
    });
    lines.push(`[정답 / 핵심] ${plainText(q.answerHTML)}`);
    if (q.detail) lines.push(`[${q.detail.label}] ${plainText(q.detail.html)}`);
    lines.push(`[해설] ${q.fact.e}`);
    return lines.join('\n');
  }

  const aiRules = (ctx, ok) => `너는 한국 '증권투자권유대행인' 자격시험을 준비하는 학습자를 돕는 튜터야.
아래는 학습자가 방금 푼 문제와 앱이 보여 준 해설이야. 학습자는 이 문제를 ${ok ? '맞혔어' : '틀렸어'}.

답변 규칙:
- 한국어로, 친절하지만 간결하게 답해. 보통 3~6문장이면 충분해. 필요하면 '•'로 시작하는 짧은 목록을 써.
- 마크다운 제목(#), 굵게(**), 표는 쓰지 말고 줄바꿈만 사용해.
- 시험에서 쓰는 정확한 용어와 수치를 사용해. 확실하지 않거나 법령·제도가 바뀌었을 수 있는 내용이면 그렇다고 말하고 최신 기본서 확인을 권해.
- 질문이 시험 공부와 무관하면 짧게 답하고 이 문제로 다시 이끌어 줘.

${ctx}`;

  function aiErrorText(code) {
    const gemini = aiProvider() === 'gemini';
    switch (code) {
      case 'cancelled': return '';
      case 'invalid_key': return '제미나이 API 키가 올바르지 않아요. 설정에서 키를 다시 확인해 주세요.';
      case 'model_missing': return '선택한 모델을 쓸 수 없어요. 설정에서 다른 모델을 골라 주세요.';
      case 'network': return '인터넷 연결이 끊겼어요. 연결을 확인하고 다시 보내 주세요.';
      case 'no_key': return '설정에서 제미나이 API 키를 먼저 등록해 주세요.';
      case 'bad_request': return '요청을 처리하지 못했어요. 설정에서 다른 모델을 골라 보세요.';
      case 'rate_limited': if (gemini) return '제미나이 무료 사용 한도에 도달했어요. 잠시 후(일일 한도라면 내일) 다시 시도해 주세요.'; break;
      default: break;
    }
    switch (code) {
      case 'not_granted': return 'AI 사용이 허용되지 않았어요. 아티팩트의 권한 메뉴에서 허용할 수 있어요.';
      case 'sampling_disabled': return '이 계정에서는 AI 기능을 사용할 수 없어요.';
      case 'rate_limited': return '요청이 많거나 사용 한도에 도달했어요. 잠시 후 다시 시도해 주세요.';
      case 'session_expired': return '로그인이 만료됐어요. 다시 로그인해 주세요.';
      case 'refused': return '이 질문에는 답할 수 없어요. 질문을 바꿔 보세요.';
      case 'empty_completion': return '답변이 비어 있어요. 질문을 조금 바꿔 보세요.';
      case 'prompt_too_large': return '대화가 너무 길어요. 다음 문제에서 새로 질문해 주세요.';
      default: return AI_BLOCKING.includes(code) ? 'AI 기능을 지금 사용할 수 없어요.' : '연결이 끊겼어요. 다시 보내 주세요.';
    }
  }

  async function askAI(text) {
    const question = String(text || '').trim();
    const provider = aiProvider();
    if (!question || !provider) return;
    const chat = chatFor();
    if (chat.busy || chat.blocked) return;
    const q = session.qs[session.i];
    const picked = session.picked[session.i];
    chat.turns.push({ role: 'user', content: question });
    chat.busy = true;
    chat.note = '';
    chat.ctl = new AbortController();
    renderAI();
    const rules = aiRules(questionContext(q, picked), q.choices[picked].correct);
    const recent = chat.turns.slice(-8); // 대화는 최근 8턴만 보낸다
    if (recent[0].role !== 'user') recent.shift();
    const onText = ({ text: live }) => {
      const el = $app.querySelector('.ai-live');
      if (el) { el.textContent = live; el.classList.remove('pending'); }
    };
    try {
      const { text: reply, truncated } = provider === 'claude'
        // Claude: 지시문을 항상 맨 앞 user 턴으로 유지
        ? await sample([{ role: 'user', content: rules }, ...recent], { cache: false, signal: chat.ctl.signal, onText })
        // 제미나이: 지시문은 systemInstruction으로 보낸다
        : await Gemini.stream({ system: rules, turns: recent, signal: chat.ctl.signal, onText });
      chat.turns.push({ role: 'assistant', content: reply });
      if (truncated) chat.note = '답변이 길어서 중간에 끊겼어요. 더 짧게 나눠서 물어봐 주세요.';
    } catch (e) {
      const code = e && e.code;
      if (e && e.text && code !== 'refused') chat.turns.push({ role: 'assistant', content: e.text });
      chat.note = aiErrorText(code);
      if (AI_BLOCKING.includes(code)) chat.blocked = true;
    } finally {
      chat.busy = false;
      chat.ctl = null;
      renderAI();
    }
  }

  function aiHTML() {
    const provider = aiProvider();
    if (!provider) {
      if (IN_CLAUDE) return '';
      return `
        <section class="panel ai ai-setup">
          <div class="ai-head">${icon.spark}<span>AI 튜터에게 질문하기</span></div>
          <p class="ai-setup-text">제미나이 API 키를 등록하면 이 해설에 대해 AI에게 바로 물어볼 수 있어요. 키는 무료로 받을 수 있어요.</p>
          <button class="btn" data-act="settings">${icon.gear}<span>AI 튜터 설정하기</span></button>
        </section>`;
    }
    const chat = chatFor();
    const msgs = chat.turns.map((t) => `<div class="ai-msg ${t.role}">${esc(t.content)}</div>`).join('');
    const live = chat.busy ? '<div class="ai-msg assistant ai-live pending">생각하는 중…</div>' : '';
    const chips = !chat.turns.length && !chat.busy && !chat.blocked
      ? `<div class="ai-chips">${AI_SUGGEST.map((s) => `<button class="chip" data-act="ai-ask" data-text="${esc(s)}">${esc(s)}</button>`).join('')}</div>`
      : '';
    const form = chat.blocked ? '' : `
      <form class="ai-form" data-form="ai">
        <textarea name="q" rows="1" placeholder="해설에서 궁금한 점을 물어보세요" aria-label="AI에게 질문" ${chat.busy ? 'disabled' : ''}></textarea>
        ${chat.busy
          ? '<button type="button" class="btn" data-act="ai-stop">중지</button>'
          : '<button type="submit" class="btn primary">보내기</button>'}
      </form>`;
    return `
      <section class="panel ai">
        <div class="ai-head">${icon.spark}<span>AI 튜터에게 질문하기</span></div>
        ${msgs || live ? `<div class="ai-msgs">${msgs}${live}</div>` : ''}
        ${chat.note ? `<p class="ai-note">${esc(chat.note)}</p>` : ''}
        ${chips}
        ${form}
        <p class="ai-foot">${provider === 'claude'
          ? 'AI 답변은 틀릴 수 있어요. 질문할 때마다 내 Claude 사용량이 쓰여요.'
          : `AI 답변은 틀릴 수 있어요. 제미나이 무료 한도 안에서 동작해요 · ${esc(Gemini.load().model)}`}</p>
      </section>`;
  }

  // 대화 영역만 다시 그린다 (문제 화면 전체를 다시 그리면 입력 중인 글이 사라짐)
  function renderAI() {
    const slot = $app.querySelector('.ai-slot');
    if (!slot) return;
    slot.innerHTML = aiHTML();
    const last = slot.querySelector('.ai-msg:last-child');
    if (last && chatFor().turns.length) last.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function go(next) {
    view = next;
    render();
    window.scrollTo(0, 0);
  }

  // ───────── 아이콘 ─────────
  const icon = {
    chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" fill="currentColor"/></svg>',
    shuffle: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5h2.5c1.5 0 2.3.6 3.2 2l1.6 3c.9 1.4 1.7 2 3.2 2H14m0-7h-1.5c-1.5 0-2.3.6-3.2 2M2 11.5h2.5c1.2 0 2-.4 2.7-1.3M12 2.5l2 2-2 2M12 9.5l2 2-2 2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    note: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h6l2.5 2.5v8.5h-8.5zM6 7h4.5M6 9.5h4.5M6 12h2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8 10 12.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    book: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4.2C6.8 3.3 5 3 2.5 3v9.5c2.5 0 4.3.3 5.5 1.2m0-9.5c1.2-.9 3-1.2 5.5-1.2v9.5c-2.5 0-4.3.3-5.5 1.2m0-9.5v9.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    pencil: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10.5 3 2.5 2.5-7 7H3.5V10zM9 4.5 11.5 7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    gear: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8 3.6 3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    spark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 9.2 6.8 13.5 8 9.2 9.2 8 13.5 6.8 9.2 2.5 8 6.8 6.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.2v3.6M8 5.2v.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  // 합격 기준 안내 카드 (홈·챕터 화면 공용)
  function passCard() {
    return `
      <section class="panel pass">
        <div class="pass-title">${icon.info}<span>합격 기준</span></div>
        <div class="pass-main">
          <div><b>${cert.pass.totalItems * cert.pass.total}문항 이상</b><span>전체 ${cert.pass.totalItems}문항 중 ${pctText(cert.pass.total)}</span></div>
          <div><b>과목별 ${pctText(cert.pass.subject)} 이상</b><span>한 과목이라도 미달하면 과락(불합격)</span></div>
        </div>
        <ul class="pass-list">${cert.subjects.map((s) => `
          <li><span>${s.id}과목 · ${esc(s.name)}</span><span><b>${cutoff(s)}</b> / ${s.items}문항</span></li>`).join('')}
        </ul>
        <p class="pass-note">과락은 챕터가 아니라 <b>과목 단위</b>로 판정해요. 시험은 ${cert.pass.minutes}분 동안 ${cert.pass.totalItems}문항을 풉니다.</p>
      </section>`;
  }

  // ───────── 화면: 홈 ─────────
  // ───────── 화면: 홈 (캐릭터 · 자격증 선택 · 남은 시험 일정) ─────────
  const DAY = 86400000;
  const toDate = (s) => new Date(`${s}T00:00:00`);
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const md = (s) => { const d = toDate(s); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };
  const weekday = (s) => '일월화수목금토'[toDate(s).getDay()];

  // 오늘 이후(오늘 포함) 시험만, 날짜순
  function upcomingExams() {
    const t = today();
    return CERTS.flatMap((c) => c.schedule.map((x) => ({ ...x, cert: c })))
      .filter((x) => toDate(x.exam) >= t)
      .sort((a, b) => toDate(a.exam) - toDate(b.exam));
  }

  function applyState(x) {
    const t = today();
    const [from, to] = x.apply.map(toDate);
    if (t < from) return { cls: 'soon', text: `접수 ${md(x.apply[0])}~${md(x.apply[1])}` };
    if (t <= to) return { cls: 'open', text: `접수 중 · ${md(x.apply[1])} 마감` };
    return { cls: 'closed', text: '접수 마감' };
  }

  // 꿈디 로고: 'D' 안에서 올라가는 차트 + 꿈을 뜻하는 반짝임
  const LOGO = `
    <svg class="logo-mark" viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="14" class="lg-tile"/>
      <path d="M14 12h9.5a12 12 0 0 1 0 24H14z" class="lg-d"/>
      <path d="M18.5 28.5l4.5-4.5 3 2.5 5.5-6.5" class="lg-up"/>
      <path d="M37 5.5l1.6 3.9 3.9 1.6-3.9 1.6L37 16.5l-1.6-3.9-3.9-1.6 3.9-1.6z" class="lg-star"/>
    </svg>`;
  const BRAND = `<div class="brand">${LOGO}<span class="brand-text"><b>꿈디</b><small>꿈을 디자인하다</small></span></div>`;

  // 메인 캐릭터: 새내기 증권맨 곰 '꿈곰' (둥근 3D 느낌, 셔츠 · 나비넥타이 · 사원증)
  const CHARACTER = `
    <svg class="character" viewBox="0 0 240 280" role="img" aria-label="셔츠와 나비넥타이 차림에 사원증을 건 귀여운 곰 캐릭터 꿈곰">
      <defs>
        <radialGradient id="kg-fur" cx="38%" cy="30%" r="75%">
          <stop offset="0" stop-color="#FFFFFF"/>
          <stop offset=".55" stop-color="#FFF1DF"/>
          <stop offset="1" stop-color="#EDCFAE"/>
        </radialGradient>
        <radialGradient id="kg-ear" cx="40%" cy="35%" r="70%">
          <stop offset="0" stop-color="#FFF6EA"/>
          <stop offset="1" stop-color="#E8C59F"/>
        </radialGradient>
        <radialGradient id="kg-inner" cx="50%" cy="40%" r="60%">
          <stop offset="0" stop-color="#FFD3C2"/>
          <stop offset="1" stop-color="#F4AE96"/>
        </radialGradient>
        <radialGradient id="kg-muzzle" cx="45%" cy="35%" r="70%">
          <stop offset="0" stop-color="#FFFFFF"/>
          <stop offset="1" stop-color="#F1E2D0"/>
        </radialGradient>
        <linearGradient id="kg-shirt" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#FFFFFF"/>
          <stop offset="1" stop-color="#D9E6F7"/>
        </linearGradient>
        <linearGradient id="kg-pants" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#3D7BFF"/>
          <stop offset="1" stop-color="#1D4FC7"/>
        </linearGradient>
        <radialGradient id="kg-bow" cx="40%" cy="35%" r="70%">
          <stop offset="0" stop-color="#FFD873"/>
          <stop offset="1" stop-color="#F2A21E"/>
        </radialGradient>
        <radialGradient id="kg-shadow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#001A4D" stop-opacity=".35"/>
          <stop offset="1" stop-color="#001A4D" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <ellipse cx="120" cy="268" rx="74" ry="11" fill="url(#kg-shadow)"/>

      <!-- 다리 -->
      <rect x="90" y="226" width="26" height="40" rx="13" fill="url(#kg-pants)"/>
      <rect x="124" y="226" width="26" height="40" rx="13" fill="url(#kg-pants)"/>
      <ellipse cx="103" cy="264" rx="15" ry="7" fill="#1A2A4D"/>
      <ellipse cx="137" cy="264" rx="15" ry="7" fill="#1A2A4D"/>

      <!-- 오른팔(아래로, 서류 파일) -->
      <ellipse cx="174" cy="204" rx="14" ry="25" transform="rotate(18 174 204)" fill="url(#kg-shirt)"/>
      <rect x="166" y="206" width="30" height="38" rx="5" transform="rotate(10 181 225)" fill="#3D7BFF"/>
      <rect x="171" y="212" width="20" height="5" rx="2" transform="rotate(10 181 225)" fill="#FFFFFF" opacity=".85"/>
      <circle cx="180" cy="226" r="11" fill="url(#kg-fur)"/>

      <!-- 몸통(셔츠) -->
      <rect x="70" y="166" width="100" height="78" rx="40" fill="url(#kg-shirt)"/>
      <path d="M78 228c10 14 74 14 84 0v8c-10 14-74 14-84 0z" fill="url(#kg-pants)"/>
      <ellipse cx="98" cy="190" rx="14" ry="8" fill="#FFFFFF" opacity=".7"/>

      <!-- 사원증 -->
      <path d="M104 172l12 32M136 172l-12 32" stroke="#2F6BFF" stroke-width="3.5" stroke-linecap="round" fill="none"/>
      <rect x="107" y="202" width="26" height="32" rx="5" fill="#FFFFFF" stroke="#C9D7EE" stroke-width="1.5"/>
      <rect x="107" y="202" width="26" height="9" rx="4" fill="#2F6BFF"/>
      <circle cx="120" cy="220" r="5" fill="#FFE3C7"/>
      <rect x="113" y="228" width="14" height="2.5" rx="1" fill="#9FB4D6"/>

      <!-- 나비넥타이 -->
      <path d="M120 174l-15-9c-3-2-6 0-6 3v12c0 3 3 5 6 3z" fill="url(#kg-bow)"/>
      <path d="M120 174l15-9c3-2 6 0 6 3v12c0 3-3 5-6 3z" fill="url(#kg-bow)"/>
      <circle cx="120" cy="174" r="5.5" fill="#F2A21E"/>

      <!-- 왼팔(흔드는 손) -->
      <ellipse cx="62" cy="168" rx="14" ry="26" transform="rotate(-38 62 168)" fill="url(#kg-shirt)"/>
      <circle cx="47" cy="146" r="13" fill="url(#kg-fur)"/>

      <!-- 귀 -->
      <circle cx="58" cy="58" r="25" fill="url(#kg-ear)"/>
      <circle cx="182" cy="58" r="25" fill="url(#kg-ear)"/>
      <circle cx="59" cy="60" r="13" fill="url(#kg-inner)"/>
      <circle cx="181" cy="60" r="13" fill="url(#kg-inner)"/>

      <!-- 머리 -->
      <ellipse cx="120" cy="106" rx="76" ry="68" fill="url(#kg-fur)"/>
      <path d="M113 40c2-12 12-17 22-12-8 1-12 6-12 13z" fill="#F3D9BB"/>
      <ellipse cx="92" cy="66" rx="28" ry="12" fill="#FFFFFF" opacity=".55"/>

      <!-- 얼굴 -->
      <ellipse cx="120" cy="128" rx="27" ry="20" fill="url(#kg-muzzle)"/>
      <g class="c-eyes">
        <ellipse cx="90" cy="104" rx="7.5" ry="9" fill="#1E1A24"/>
        <ellipse cx="150" cy="104" rx="7.5" ry="9" fill="#1E1A24"/>
      </g>
      <circle cx="92.5" cy="100.5" r="2.6" fill="#FFFFFF"/>
      <circle cx="152.5" cy="100.5" r="2.6" fill="#FFFFFF"/>
      <ellipse cx="120" cy="120" rx="9.5" ry="7" fill="#2A2230"/>
      <ellipse cx="117" cy="117.5" rx="3" ry="1.8" fill="#FFFFFF" opacity=".7"/>
      <path d="M111 131q4.5 6 9 0q4.5 6 9 0" stroke="#2A2230" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <ellipse cx="76" cy="124" rx="12" ry="7" fill="#FF9DA0" opacity=".55"/>
      <ellipse cx="164" cy="124" rx="12" ry="7" fill="#FF9DA0" opacity=".55"/>
    </svg>`;

  // 히어로 배경 장식 (구름 · 반짝임)
  const HERO_DECO = `
    <span class="cloud c1" aria-hidden="true"></span>
    <span class="cloud c2" aria-hidden="true"></span>
    <span class="spark s1" aria-hidden="true"></span>
    <span class="spark s2" aria-hidden="true"></span>`;

  function homeView() {
    const exams = upcomingExams();
    const t = today();
    // 홈에서는 자격증 이름만 보여 주고, 자세한 정보는 들어가서 확인한다
    const cards = CERTS.map((c) => `
        <button class="cert-pick" data-act="pick-cert" data-id="${c.id}">
          <span class="cert-chip">${esc(c.short)}</span>
          <span class="cert-name">${esc(c.name)}</span>
          ${icon.chevron}
        </button>`).join('');

    const rows = exams.map((x) => {
      const dday = Math.round((toDate(x.exam) - t) / DAY);
      const st = applyState(x);
      return `
        <li class="exam-row">
          <span class="exam-date"><b>${md(x.exam)}</b><small>(${weekday(x.exam)})</small></span>
          <span class="exam-main">
            <span class="exam-name">${esc(x.cert.name)} <small>${esc(x.round)}</small></span>
            <span class="exam-sub"><span class="apply ${st.cls}">${st.text}</span> · 합격 발표 ${md(x.result)}</span>
          </span>
          <span class="dday ${dday === 0 ? 'today' : ''}">${dday === 0 ? '오늘' : `D-${dday}`}</span>
        </li>`;
    }).join('');

    return `
      <section class="hero hero-home">
        ${HERO_DECO}
        <header class="hero-bar">
          ${BRAND}
          <button class="icon-btn on-hero" data-act="settings" aria-label="설정">${icon.gear}</button>
        </header>
        <div class="hero-copy">
          <p class="hero-eyebrow">금융 자격증 학습</p>
          <h1 class="hero-title">어떤 자격증을<br>공부해 볼까?</h1>
          <p class="hero-sub">챕터별 개념 공부부터<br>실제 시험형 문제까지</p>
        </div>
        <div class="hero-art">${CHARACTER}</div>
      </section>

      <main class="page sheet">
        <h2 class="sheet-title">자격증 선택</h2>
        <section class="cert-picks">${cards}</section>

        <h2 class="section-title">${t.getFullYear()}년 남은 시험 일정 <span class="hint">금융투자협회 시행</span></h2>
        <section class="panel">
          ${exams.length ? `<ul class="exam-list">${rows}</ul>` : `
            <p class="exam-empty">${t.getFullYear()}년에 남은 시험이 없어요. 내년 일정이 발표되면 금융투자협회에서 확인해 주세요.</p>`}
        </section>
        <p class="footnote">시험 일정은 금융투자협회 ${t.getFullYear()}년 공지(교육업체 안내 기준)를 옮긴 것이에요. 접수 전 <a href="https://license.kofia.or.kr" target="_blank" rel="noopener">금융투자협회 자격시험센터</a>에서 꼭 다시 확인하세요.</p>
      </main>`;
  }

  function certView() {
    const seen = cert.items.filter((f) => db.facts[f.id] && db.facts[f.id].n).length;
    const totals = cert.items.map((f) => db.facts[f.id]).filter(Boolean)
      .reduce((a, s) => ({ n: a.n + s.n, ok: a.ok + s.ok }), { n: 0, ok: 0 });
    const rate = totals.n ? Math.round((totals.ok / totals.n) * 100) : 0;
    const wrongN = wrongFacts().length;

    const subjects = cert.subjects.map((s) => {
      const rows = cert.chapters.filter((c) => c.s === s.id).map((c) => {
        const fs = chapterItems(c);
        const pct = masteryPct(fs);
        return `
          <button class="row" data-act="chapter" data-s="${c.s}" data-t="${esc(c.t)}">
            <span class="row-main">
              <span class="row-title">${esc(chapterName(c))}</span>
              <span class="row-sub">시험 ${c.items}문항 · 학습 개념 ${fs.length}개</span>
              <span class="meter" aria-label="숙지율 ${pct}%"><i style="width:${pct}%"></i></span>
            </span>
            <span class="row-end"><span class="row-pct">${pct}%</span>${icon.chevron}</span>
          </button>`;
      }).join('');
      return `
        <h2 class="section-title subject-title">
          <span class="row-num">${s.id}</span>
          <span class="st-main"><span>${esc(s.name)}</span><span class="hint">${s.items}문항 · ${cutoff(s)}문항 이상 맞혀야 과락 면제</span></span>
        </h2>
        <section class="panel list">
          ${rows}
          <button class="row row-action" data-act="subject" data-id="${s.id}">${icon.shuffle}<span>${s.id}과목 전체 섞어서 풀기</span></button>
        </section>`;
    }).join('');

    const chips = ALL_TYPES.map((t) => `
      <button class="chip ${db.types.includes(t) ? 'on' : ''}" data-act="type" data-type="${t}" aria-pressed="${db.types.includes(t)}">
        ${icon.check}<span>${TYPES[t].label}</span>
      </button>`).join('');

    return `
      <section class="hero hero-cert">
        ${HERO_DECO}
        <header class="hero-bar">
          <button class="icon-btn on-hero" data-act="home" aria-label="자격증 선택으로">${icon.back}</button>
          <div class="topbar-actions">
            <button class="icon-btn on-hero" data-act="notes" aria-label="오답노트">${icon.note}${wrongN ? `<span class="badge">${wrongN}</span>` : ''}</button>
            <button class="icon-btn on-hero" data-act="settings" aria-label="설정">${icon.gear}</button>
          </div>
        </header>
        <div class="hero-copy">
          <p class="hero-eyebrow">${esc(cert.short)} · ${cert.pass.totalItems}문항 · ${cert.pass.minutes}분</p>
          <h1 class="hero-title">${esc(cert.name)}</h1>
          <p class="hero-sub">${esc(cert.desc)}</p>
          <p class="hero-say">오늘도 한 챕터씩<br>같이 가 볼까요?</p>
        </div>
        <div class="hero-art">${CHARACTER}</div>
      </section>

      <main class="page sheet">
        <section class="panel stats">
          <div class="stat"><span class="stat-val">${seen}<small>/${cert.items.length}</small></span><span class="stat-key">학습한 개념</span></div>
          <div class="stat"><span class="stat-val">${rate}<small>%</small></span><span class="stat-key">정답률</span></div>
          <div class="stat"><span class="stat-val">${wrongN}</span><span class="stat-key">오답노트</span></div>
        </section>

        <section class="stack">
          <button class="btn primary lg" data-act="random">${icon.play}<span>전 과목 랜덤 ${SESSION_SIZE}문제</span></button>
          <button class="btn lg" data-act="review" ${wrongN ? '' : 'disabled'}>${icon.note}<span>오답노트 복습${wrongN ? ` · ${wrongN}개` : ''}</span></button>
        </section>

        ${passCard()}

        ${subjects}

        <h2 class="section-title">출제 유형 <span class="hint">실제 시험처럼 모두 4지선다로 나오고, 같은 개념도 유형이 바뀌어요</span></h2>
        <section class="chips">${chips}</section>

        <p class="footnote">학습 기록은 이 기기의 브라우저에만 저장됩니다. 문제 내용은 학습 보조용이며, 최신 법령·협회 기본서와 함께 확인하세요.</p>
      </main>`;
  }

  // ───────── 화면: 설정 (제미나이 AI 튜터) ─────────
  let settingsMsg = null;   // { kind: 'ok' | 'bad' | 'info', text }
  let settingsBusy = false;
  let settingsBack = 'cert';

  function settingsView() {
    const cfg = Gemini.load();
    const connected = Gemini.ready();
    const models = cfg.models || [];

    const body = IN_CLAUDE ? `
        <section class="panel callout">
          ${icon.info}
          <p>지금은 claude.ai에서 열려 있어서 <b>Claude</b>가 AI 튜터로 동작해요. 제미나이 설정은 웹사이트 버전에서 할 수 있어요.</p>
        </section>` : `
        <section class="panel set-card">
          <div class="set-head">
            <span class="set-title">${icon.spark}<span>AI 튜터 · 제미나이</span></span>
            <span class="pill ${connected ? 'ok' : ''}">${connected ? '연결됨' : '설정 안 됨'}</span>
          </div>

          ${connected ? `
            <label class="field-label" for="gemini-model">사용할 모델</label>
            <select id="gemini-model" class="field" data-change="gemini-model">
              ${models.map((m) => `<option value="${esc(m.id)}" ${m.id === cfg.model ? 'selected' : ''}>${esc(m.label)} (${esc(m.id)})</option>`).join('')}
            </select>
            <p class="set-hint">Flash-Lite가 가장 빠르고 무료 한도가 넉넉해요. 답변이 아쉬우면 Flash를 골라 보세요.</p>
            <div class="set-row">
              <button class="btn" data-act="gemini-test" ${settingsBusy ? 'disabled' : ''}>연결 다시 확인</button>
              <button class="btn danger" data-act="gemini-clear">키 삭제</button>
            </div>` : `
            <ol class="steps">
              <li><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>에 구글 계정으로 로그인해요.</li>
              <li><b>API 키 만들기(Create API key)</b>를 눌러요. 카드 등록은 필요 없어요.</li>
              <li>만들어진 키를 복사해서 아래 칸에 붙여 넣어요.</li>
            </ol>
            <form class="set-form" data-form="gemini">
              <label class="field-label" for="gemini-key">API 키</label>
              <input id="gemini-key" name="key" class="field" type="password" autocomplete="off" spellcheck="false" placeholder="AIza로 시작하는 키" ${settingsBusy ? 'disabled' : ''}>
              <button type="submit" class="btn primary lg" ${settingsBusy ? 'disabled' : ''}>${settingsBusy ? '연결 확인 중…' : '저장하고 연결 확인'}</button>
            </form>`}

          ${settingsMsg ? `<p class="set-msg ${settingsMsg.kind}">${esc(settingsMsg.text)}</p>` : ''}
        </section>

        <section class="panel callout">
          ${icon.info}
          <p>키는 <b>이 기기의 브라우저에만</b> 저장되고 다른 곳으로 보내지 않아요. 키는 다른 사람과 공유하지 마세요.
          무료 등급에서는 보낸 내용(문제와 질문)이 구글 서비스 개선에 쓰일 수 있어요.</p>
        </section>`;

    return `
      <header class="topbar">
        <button class="icon-btn" data-act="settings-back" aria-label="뒤로">${icon.back}</button>
        <div class="topbar-title">설정</div>
        <span class="icon-btn ghost"></span>
      </header>
      <main class="page">${body}</main>`;
  }

  async function connectGemini(key) {
    const k = String(key || '').trim();
    if (!k) { settingsMsg = { kind: 'bad', text: 'API 키를 붙여 넣어 주세요.' }; render(); return; }
    settingsBusy = true;
    settingsMsg = { kind: 'info', text: '제미나이에 연결하고 있어요…' };
    render();
    try {
      const models = await Gemini.listModels(k);
      if (!models.length) throw { code: 'no_models' };
      const prev = Gemini.load().model;
      const model = models.some((m) => m.id === prev) ? prev : models[0].id;
      Gemini.save({ key: k, model, models });
      settingsMsg = { kind: 'ok', text: `연결됐어요. 문제를 풀고 해설 아래에서 질문해 보세요. (${model})` };
    } catch (e) {
      const code = e && e.code;
      settingsMsg = {
        kind: 'bad',
        text: code === 'invalid_key' ? '키가 올바르지 않아요. AI Studio에서 복사한 키 전체를 붙여 넣었는지 확인해 주세요.'
          : code === 'network' ? '인터넷 연결을 확인하고 다시 시도해 주세요.'
            : code === 'rate_limited' ? '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.'
              : code === 'no_models' ? '이 키로 쓸 수 있는 텍스트 모델이 없어요. 다른 키로 시도해 주세요.'
                : '연결하지 못했어요. 잠시 후 다시 시도해 주세요.',
      };
    } finally {
      settingsBusy = false;
      render();
    }
  }

  // ───────── 화면: 챕터 ─────────
  function chapterView() {
    const c = chapter;
    const s = subjectOf(c.s);
    const fs = chapterItems(c);
    const pct = masteryPct(fs);
    const wrongN = fs.filter((f) => db.facts[f.id] && db.facts[f.id].wrong).length;
    const qn = Math.max(Math.min(SESSION_SIZE, fs.length), Math.min(MIN_SESSION, fs.length * 3));

    return `
      <header class="topbar">
        <button class="icon-btn" data-act="cert" aria-label="자격증 홈으로">${icon.back}</button>
        <div class="topbar-title">${s.id}과목 · ${esc(s.name)}</div>
        <span class="icon-btn ghost"></span>
      </header>
      <main class="page">
        <div class="ch-head">
          <h1 class="ch-title">${esc(chapterName(c))}</h1>
          <p class="ch-desc">${esc(c.desc)}</p>
        </div>

        <section class="panel stats">
          <div class="stat"><span class="stat-val">${c.items}<small>문항</small></span><span class="stat-key">실제 시험 출제</span></div>
          <div class="stat"><span class="stat-val">${fs.length}<small>개</small></span><span class="stat-key">학습 개념</span></div>
          <div class="stat"><span class="stat-val">${pct}<small>%</small></span><span class="stat-key">숙지율</span></div>
        </section>

        <section class="modes">
          <button class="mode" data-act="study">
            <span class="mode-icon">${icon.book}</span>
            <span class="mode-main">
              <span class="mode-title">개념 공부</span>
              <span class="mode-sub">문제 없이 핵심 문장과 해설만 차근차근 읽어요</span>
            </span>
            ${icon.chevron}
          </button>
          <button class="mode primary" data-act="chapter-quiz">
            <span class="mode-icon">${icon.pencil}</span>
            <span class="mode-main">
              <span class="mode-title">문제 풀기 · ${qn}문제</span>
              <span class="mode-sub">같은 개념도 유형과 보기가 매번 바뀌어 나와요</span>
            </span>
            ${icon.chevron}
          </button>
        </section>

        <section class="panel callout">
          ${icon.info}
          <p>이 챕터는 <b>${s.id}과목(${s.items}문항)</b>에 속해요. 과락은 과목 단위로 판정하므로
          ${s.id}과목 전체에서 <b>${cutoff(s)}문항 이상</b> 맞혀야 하고, 시험 전체로는 <b>${cert.pass.totalItems * cert.pass.total}문항 이상</b>이 필요해요.
          ${wrongN ? `<br>이 챕터에서 오답노트에 남은 개념은 <b>${wrongN}개</b>예요.` : ''}</p>
        </section>
      </main>`;
  }

  // ───────── 화면: 개념 공부 (설명만) ─────────
  // ==글자== → 밑줄(자주 출제)
  const rich = (s) => esc(s).replace(/==(.+?)==/g, '<u class="hot">$1</u>');

  function blockHTML(b) {
    if (b.h) return `<h3 class="ls-h">${rich(b.h)}</h3>`;
    if (b.p) return `<p class="ls-p">${rich(b.p)}</p>`;
    if (b.ul) return `<ul class="ls-ul">${b.ul.map((x) => `<li>${rich(x)}</li>`).join('')}</ul>`;
    if (b.f) return `<div class="ls-f">${b.f.map((x) => `<div>${rich(x)}</div>`).join('')}</div>`;
    if (b.tip) return `<p class="ls-tip"><b>시험 포인트</b>${rich(b.tip)}</p>`;
    if (b.t) {
      const [head, ...rows] = b.t;
      return `<div class="ls-table"><table>
        <thead><tr>${head.map((x) => `<th>${rich(x)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((x) => `<td>${rich(x)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>`;
    }
    return '';
  }

  const lessonHTML = (key) => {
    const l = LESSONS[key];
    return l ? `<article class="panel lesson"><h2 class="ls-title">${esc(l.title)}</h2>${l.blocks.map(blockHTML).join('')}</article>` : '';
  };

  function studyView() {
    const c = chapter;
    const fs = chapterItems(c);
    const lessons = ((LESSON_MAP[cert.id] || {})[c.t] || []).filter((k) => LESSONS[k]);
    const cards = fs.map((f, i) => {
      const st = db.facts[f.id];
      const status = st && st.wrong ? '<span class="sc-badge bad">오답노트</span>'
        : isMastered(f) ? '<span class="sc-badge ok">맞힌 개념</span>' : '';
      let body;
      if (f.gen) {
        const ex = studyExamples[f.id];
        body = `
          <p class="sc-text"><b>${esc(f.name)}</b><br><mark class="ok">${esc(f.formula)}</mark></p>
          <div class="sc-example">
            <div class="ex-label">예제</div>
            <p>${esc(ex.stem)}</p>
            <p class="solve">${esc(ex.solve)}</p>
          </div>`;
      } else {
        body = `<p class="sc-text">${esc(f.q).replace('{}', `<mark class="ok">${esc(f.a)}</mark>`)}</p>
          <p class="sc-trap">자주 나오는 오답 보기 · ${f.w.map((w) => `<del>${esc(w)}</del>`).join(' ')}</p>`;
      }
      return `
        <article class="panel study-card">
          <div class="sc-head"><span class="sc-num">${String(i + 1).padStart(2, '0')}</span>${status}</div>
          ${body}
          <p class="sc-ex">${esc(f.e)}</p>
        </article>`;
    }).join('');

    return `
      <header class="topbar">
        <button class="icon-btn" data-act="back-chapter" aria-label="챕터로">${icon.back}</button>
        <div class="topbar-title">개념 공부 · ${esc(chapterName(c))}</div>
        <span class="icon-btn ghost"></span>
      </header>
      <main class="page">
        ${lessons.length ? `
          <p class="lead"><u class="hot">밑줄</u>은 시험에 자주 나오는 부분이에요. 처음부터 끝까지 읽고 아래 핵심 문장으로 확인해 보세요.</p>
          ${lessons.map(lessonHTML).join('')}` : ''}
        <h2 class="section-title">핵심 문장 확인 <span class="hint">${fs.length}개 · <mark class="ok">강조된 부분</mark>이 시험에서 바뀌어 나와요</span></h2>
        <div class="study-list">${cards}</div>
      </main>
      <div class="dock"><button class="btn primary lg" data-act="chapter-quiz">${icon.pencil}<span>이 챕터 문제 풀기</span></button></div>`;
  }

  // ───────── 화면: 문제 ─────────
  function quizView() {
    const q = session.qs[session.i];
    const picked = session.picked[session.i];
    const answered = picked != null;
    const ok = answered && q.choices[picked].correct;
    const subj = subjectOf(q.fact.s);
    const pct = ((session.i + (answered ? 1 : 0)) / session.qs.length) * 100;
    const isPick = q.type === 'pickTrue' || q.type === 'pickFalse';

    const choiceState = (c, i) => {
      if (!answered) return '';
      if (c.correct) return 'is-correct';
      if (i === picked) return 'is-wrong';
      return 'is-dim';
    };

    const choices = `<ol class="choices">${q.choices.map((c, i) => `
          <li>
            <button class="choice ${choiceState(c, i)}" data-act="answer" data-i="${i}" ${answered ? 'disabled' : ''}>
              <span class="choice-key">${answered && c.correct ? icon.check : answered && i === picked ? icon.cross : i + 1}</span>
              <span class="choice-body">
                <span class="choice-text">${c.html}</span>
                ${answered && isPick ? `<span class="choice-note ${c.statementTrue ? 'true' : 'false'}">${c.note}</span>` : ''}
              </span>
            </button>
          </li>`).join('')}</ol>`;

    const explain = answered ? `
      <section class="explain ${ok ? 'is-ok' : 'is-bad'}" aria-live="polite">
        <div class="verdict">${ok ? icon.check : icon.cross}<span>${ok ? '정답이에요' : '오답이에요'}</span></div>
        <div class="ex-label">${q.detail ? '정답' : '핵심 문장'}</div>
        <p class="ex-answer">${q.answerHTML}</p>
        ${q.detail ? `<div class="ex-label">${q.detail.label}</div><div class="ex-detail">${q.detail.html}</div>` : ''}
        <div class="ex-label">해설</div>
        <p class="ex-body">${esc(q.fact.e)}</p>
      </section>
      <div class="ai-slot">${aiHTML()}</div>` : '';

    const last = session.i === session.qs.length - 1;

    return `
      <header class="quizbar">
        <button class="icon-btn" data-act="quit" aria-label="그만 풀기">${icon.close}</button>
        <div class="progress" role="progressbar" aria-valuenow="${session.i + 1}" aria-valuemin="1" aria-valuemax="${session.qs.length}"><i style="width:${pct}%"></i></div>
        <span class="count">${session.i + 1}<small>/${session.qs.length}</small></span>
      </header>

      <main class="page quiz">
        <div class="meta">
          <span class="tag">${TYPES[q.type].label}</span>
          <span class="crumb">${subj.id}과목 · ${esc(q.fact.t)}</span>
        </div>
        <h1 class="prompt">${q.prompt}</h1>
        ${q.stem ? `<div class="stem">${q.stem}</div>` : ''}
        ${choices}
        ${explain}
      </main>

      ${answered ? `
      <div class="dock">
        <button class="btn primary lg" data-act="next">${last ? '결과 보기' : '다음 문제'}</button>
      </div>` : ''}`;
  }

  // ───────── 화면: 결과 ─────────
  function resultView() {
    const items = session.qs.map((q, i) => ({ q, ok: q.choices[session.picked[i]].correct }));
    const score = items.filter((x) => x.ok).length;
    const wrongs = items.filter((x) => !x.ok);
    const pct = Math.round((score / items.length) * 100);
    const rate = score / items.length;
    const msg = pct === 100 ? '완벽해요!' : rate >= cert.pass.total ? '합격선을 넘었어요' : rate >= cert.pass.subject ? '과락은 면했어요' : '해설을 꼭 다시 읽어 봐요';

    // 합격 기준과 비교 (과락 40% · 합격 60%)
    const s = session.scope ? subjectOf(session.scope.s) : null;
    const judge = rate >= cert.pass.total
      ? { cls: 'ok', text: `합격선 ${pctText(cert.pass.total)}을 넘었어요. 이 정답률을 유지하면 합격권이에요.` }
      : rate >= cert.pass.subject
        ? { cls: 'mid', text: `과락선 ${pctText(cert.pass.subject)}은 넘었지만 합격선 ${pctText(cert.pass.total)}에는 못 미쳐요.` }
        : { cls: 'bad', text: `과락선 ${pctText(cert.pass.subject)} 미만이에요. 실제 시험이라면 ${s ? `${s.id}과목` : '이 과목'} 과락으로 불합격이에요.` };
    const scale = s
      ? `실제 시험 ${s.id}과목 ${s.items}문항으로 환산하면 약 <b>${Math.round(rate * s.items)}문항</b> (과락 면제 ${cutoff(s)}문항 이상)`
      : `실제 시험 ${cert.pass.totalItems}문항으로 환산하면 약 <b>${Math.round(rate * cert.pass.totalItems)}문항</b> (합격 ${cert.pass.totalItems * cert.pass.total}문항 이상)`;
    const judgeCard = `
      <section class="panel judge ${judge.cls}">
        <div class="judge-bar" aria-hidden="true">
          <i style="width:${pct}%"></i>
          <span class="tick" style="left:${cert.pass.subject * 100}%"><em>과락 ${pctText(cert.pass.subject)}</em></span>
          <span class="tick" style="left:${cert.pass.total * 100}%"><em>합격 ${pctText(cert.pass.total)}</em></span>
        </div>
        <p class="judge-text">${judge.text}</p>
        <p class="judge-sub">${scale}${session.kind === 'chapter' ? '<br>실제 과락 판정은 챕터가 아닌 과목 전체 기준이에요.' : ''}</p>
      </section>`;

    const list = items.map(({ q, ok }) => `
      <details class="result-item">
        <summary>
          <span class="dot ${ok ? 'ok' : 'bad'}">${ok ? icon.check : icon.cross}</span>
          <span class="ri-main">
            <span class="ri-type">${TYPES[q.type].label} · ${esc(q.fact.t)}</span>
            <span class="ri-text">${q.answerHTML}</span>
          </span>
          ${icon.chevron}
        </summary>
        <p class="ri-ex">${esc(q.fact.e)}</p>
      </details>`).join('');

    return `
      <header class="topbar">
        <button class="icon-btn" data-act="cert" aria-label="자격증 홈으로">${icon.back}</button>
        <div class="topbar-title">${esc(session.title)}</div>
        <span class="icon-btn ghost"></span>
      </header>
      <main class="page">
        <section class="panel score">
          <div class="score-ring" style="--p:${pct}"><span>${score}<small>/${items.length}</small></span></div>
          <div class="score-msg">${msg}</div>
          <div class="score-sub">${wrongs.length ? `틀린 개념 ${wrongs.length}개가 오답노트에 담겼어요` : '모두 맞혔어요'}</div>
        </section>

        ${session.kind === 'review' ? '' : judgeCard}

        <section class="stack">
          <button class="btn primary lg" data-act="again-variant">${icon.shuffle}<span>같은 개념, 다른 유형으로 다시</span></button>
          ${wrongs.length ? `<button class="btn lg" data-act="again-wrong">${icon.note}<span>틀린 개념만 다시 · ${wrongs.length}개</span></button>` : ''}
        </section>

        <h2 class="section-title">문제별 정답과 해설</h2>
        <section class="panel list">${list}</section>
      </main>
      <div class="dock">${session.back === 'chapter'
        ? `<div class="dock-row"><button class="btn lg" data-act="cert">자격증 홈</button><button class="btn lg" data-act="back-chapter">챕터로</button></div>`
        : '<button class="btn lg" data-act="cert">자격증 홈</button>'}</div>`;
  }

  // ───────── 화면: 오답노트 ─────────
  function notesView() {
    const ws = wrongFacts();
    const groups = cert.subjects.map((s) => {
      const fs = ws.filter((f) => f.s === s.id);
      if (!fs.length) return '';
      return `
        <h2 class="section-title">${s.id}과목 · ${esc(s.name)}</h2>
        <section class="panel list">${fs.map((f) => {
          const st = db.facts[f.id];
          return `
          <details class="result-item">
            <summary>
              <span class="dot bad">${icon.cross}</span>
              <span class="ri-main">
                <span class="ri-type">${esc(f.t)} · ${st.n - st.ok}회 틀림${st.streak ? ` · 연속 정답 ${st.streak}` : ''}</span>
                <span class="ri-text">${f.gen
                  ? `${esc(f.name)} · <mark class="ok">${esc(f.formula)}</mark>`
                  : esc(f.q).replace('{}', `<mark class="ok">${esc(f.a)}</mark>`)}</span>
              </span>
              ${icon.chevron}
            </summary>
            <p class="ri-ex">${esc(f.e)}</p>
          </details>`;
        }).join('')}</section>`;
    }).join('');

    return `
      <header class="topbar">
        <button class="icon-btn" data-act="cert" aria-label="자격증 홈으로">${icon.back}</button>
        <div class="topbar-title">오답노트</div>
        <span class="icon-btn ghost"></span>
      </header>
      <main class="page">
        ${ws.length ? `
          <p class="lead">틀린 개념은 다른 유형으로 <b>연속 2번</b> 맞히면 오답노트에서 빠져요.</p>
          ${groups}` : `
          <section class="panel empty">
            <div class="empty-icon">${icon.check}</div>
            <div class="empty-title">오답노트가 비어 있어요</div>
            <div class="empty-sub">문제를 풀다 틀린 개념이 여기에 모여요.</div>
          </section>`}
      </main>
      ${ws.length ? `<div class="dock"><button class="btn primary lg" data-act="review">${icon.play}<span>오답 복습 시작 · ${ws.length}개</span></button></div>` : ''}`;
  }

  function render() {
    const html = {
      home: homeView, cert: certView, chapter: chapterView, study: studyView, settings: settingsView,
      quiz: quizView, result: resultView, notes: notesView,
    }[view]();
    $app.innerHTML = html;
    document.body.dataset.view = view;
  }

  // ───────── 동작 ─────────
  function answer(i) {
    if (session.picked[session.i] != null) return;
    session.picked[session.i] = i;
    const q = session.qs[session.i];
    record(q.fact, q.choices[i].correct);
    render();
    const ex = $app.querySelector('.explain');
    if (ex) ex.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function next() {
    if (session.i < session.qs.length - 1) {
      session.i += 1;
      go('quiz');
    } else {
      go('result');
    }
  }

  const actions = {
    random: () => startSession('전 과목 랜덤', cert.items),
    subject: (el) => {
      const s = subjectOf(Number(el.dataset.id));
      startSession(`${s.id}과목 · ${s.name}`, cert.items.filter((f) => f.s === s.id), { scope: { s: s.id }, kind: 'subject' });
    },
    chapter: (el) => {
      chapter = cert.chapters.find((c) => c.s === Number(el.dataset.s) && c.t === el.dataset.t);
      go('chapter');
    },
    'back-chapter': () => go('chapter'),
    study: () => {
      studyExamples = {};
      chapterItems(chapter).filter((f) => f.gen).forEach((f) => { studyExamples[f.id] = f.gen(); });
      go('study');
    },
    'chapter-quiz': () => startSession(chapterName(chapter), chapterItems(chapter), {
      scope: { s: chapter.s }, back: 'chapter', kind: 'chapter',
    }),
    review: () => startSession('오답노트 복습', wrongFacts(), { kind: 'review' }),
    notes: () => go('notes'),
    cert: () => go('cert'),
    type: (el) => {
      const t = el.dataset.type;
      if (db.types.includes(t)) {
        if (db.types.length === 1) return; // 최소 1개 유형은 유지
        db.types = db.types.filter((x) => x !== t);
      } else {
        db.types = ALL_TYPES.filter((x) => x === t || db.types.includes(x));
      }
      save();
      render();
    },
    answer: (el) => answer(Number(el.dataset.i)),
    home: () => go('home'),
    'pick-cert': (el) => {
      cert = CERTS.find((c) => c.id === el.dataset.id);
      chapter = null;
      go('cert');
    },
    settings: () => {
      settingsBack = view;
      settingsMsg = null;
      if (view === 'quiz') { view = 'settings'; render(); window.scrollTo(0, 0); return; }
      go('settings');
    },
    // 문제 화면에서 설정으로 왔다면 푸는 중이던 문제로 그대로 돌아간다
    'settings-back': () => go(settingsBack === 'settings' ? 'cert' : settingsBack),
    'gemini-test': () => connectGemini(Gemini.load().key),
    'gemini-clear': () => {
      Gemini.clear();
      settingsMsg = { kind: 'info', text: '키를 삭제했어요.' };
      render();
    },
    'ai-ask': (el) => askAI(el.dataset.text),
    'ai-stop': () => { const chat = chatFor(); if (chat.ctl) chat.ctl.abort(); },
    next,
    // claude.ai 화면에서는 confirm 창이 뜨지 않으므로 묻지 않고 나간다 (푼 기록은 이미 저장됨)
    quit: () => {
      const chat = session.chats && session.chats[session.i];
      if (chat && chat.ctl) chat.ctl.abort();
      go(session.back);
    },
    'again-variant': () => {
      const avoid = {};
      session.qs.forEach((q) => { avoid[q.fact.id] = q.type; });
      startSession(session.title, session.qs.map((q) => q.fact), {
        keepAll: true, avoid, scope: session.scope, back: session.back, kind: session.kind,
      });
    },
    'again-wrong': () => {
      const avoid = {};
      const facts = session.qs.filter((q, i) => !q.choices[session.picked[i]].correct)
        .map((q) => { avoid[q.fact.id] = q.type; return q.fact; });
      startSession('틀린 개념 다시', facts, { keepAll: true, avoid, back: session.back, kind: 'review' });
    },
  };

  $app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.act];
    if (fn) fn(el);
  });

  $app.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.dataset.form === 'ai') { e.preventDefault(); askAI(form.elements.q.value); }
    if (form.dataset.form === 'gemini') { e.preventDefault(); connectGemini(form.elements.key.value); }
  });

  $app.addEventListener('change', (e) => {
    if (e.target.dataset.change !== 'gemini-model') return;
    Gemini.save({ ...Gemini.load(), model: e.target.value });
    settingsMsg = { kind: 'ok', text: `모델을 ${e.target.value}(으)로 바꿨어요.` };
    render();
  });

  // AI 질문 입력창: Enter 보내기, Shift+Enter 줄바꿈, 내용에 맞춰 높이 조절
  $app.addEventListener('keydown', (e) => {
    if (!e.target.matches('.ai-form textarea')) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      askAI(e.target.value);
    }
  });
  $app.addEventListener('input', (e) => {
    if (!e.target.matches('.ai-form textarea')) return;
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
  });

  // 키보드: 1~4 보기 선택, Enter 다음 (입력창에 쓰는 중에는 무시)
  document.addEventListener('keydown', (e) => {
    if (view !== 'quiz' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const q = session.qs[session.i];
    const answered = session.picked[session.i] != null;
    if (e.key === 'Enter' && answered) { e.preventDefault(); next(); return; }
    if (answered) return;
    const n = Number(e.key);
    if (n >= 1 && n <= q.choices.length) answer(n - 1);
  });

  render();
})();
