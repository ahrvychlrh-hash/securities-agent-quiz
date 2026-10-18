/*
 * 문제 변형 엔진
 * 개념 문장 하나(FACTS의 항목)로 4가지 유형의 문제를 만든다.
 * 같은 개념이라도 유형, 오답 보기, 보기 순서, O/X 참·거짓이 매번 달라진다.
 */
const Engine = (() => {
  const TYPES = {
    blank:     { label: '빈칸 채우기' },
    ox:        { label: 'O / X' },
    pickTrue:  { label: '옳은 것 고르기' },
    pickFalse: { label: '옳지 않은 것 고르기' },
    combo:     { label: '모두 고르기 (ㄱ~ㄹ)' },
    calc:      { label: '계산형' },
  };
  const LETTERS = ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ'];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const parts = (f) => f.q.split('{}');

  // {} 자리에 값을 넣은 평문 (보기·지문용 — 힌트가 되지 않도록 강조 없음)
  const sentence = (f, v) => { const [pre, post] = parts(f); return esc(pre) + esc(v) + esc(post); };

  // {} 자리를 강조한 문장 (해설용)
  const marked = (f, v, cls) => {
    const [pre, post] = parts(f);
    return `${esc(pre)}<mark class="${cls}">${esc(v)}</mark>${esc(post)}`;
  };

  const correctSentence = (f) => marked(f, f.a, 'ok');

  function make(fact, type, pool) {
    const base = { type, fact, answerHTML: correctSentence(fact) };

    if (type === 'blank') {
      const opts = shuffle([fact.a, ...shuffle(fact.w).slice(0, 3)]);
      const [pre, post] = parts(fact);
      return {
        ...base,
        prompt: '빈칸에 들어갈 알맞은 말은?',
        stem: `${esc(pre)}<span class="blank" aria-label="빈칸"></span>${esc(post)}`,
        choices: opts.map((v) => ({ html: esc(v), correct: v === fact.a })),
      };
    }

    if (type === 'ox') {
      const isTrue = Math.random() < 0.5;
      const v = isTrue ? fact.a : pick(fact.w);
      return {
        ...base,
        prompt: '다음 설명이 옳으면 O, 틀리면 X를 고르세요.',
        stem: sentence(fact, v),
        ox: true,
        statementTrue: isTrue,
        wrongValue: isTrue ? null : v,
        choices: [
          { html: 'O', correct: isTrue },
          { html: 'X', correct: !isTrue },
        ],
      };
    }

    if (type === 'combo') {
      // 실제 시험의 "옳은 것을 모두 고르면?" 형식. 문장마다 참/거짓이 매번 새로 정해진다
      const items = shuffle([fact, ...shuffle(pool.filter((f) => f.id !== fact.id)).slice(0, 3)]);
      let truth;
      do { truth = items.map(() => Math.random() < 0.5); } while (!truth.some(Boolean));
      const stmts = items.map((f, i) => ({ f, isTrue: truth[i], v: truth[i] ? f.a : pick(f.w) }));
      const label = (t) => t.map((x, i) => (x ? LETTERS[i] : null)).filter(Boolean).join(', ');
      const ans = label(truth);
      // 정답과 1~2개만 다른 조합을 오답으로 우선 사용해 헷갈리게 만든다
      const others = [];
      for (let m = 1; m < 1 << items.length; m++) {
        const t = items.map((_, i) => !!(m & (1 << i)));
        const k = label(t);
        if (k !== ans) others.push({ k, d: t.filter((x, i) => x !== truth[i]).length });
      }
      const wrongs = shuffle(others).sort((a, b) => Math.abs(a.d - 1.5) - Math.abs(b.d - 1.5)).slice(0, 3).map((x) => x.k);
      return {
        ...base,
        prompt: '다음 중 옳은 것을 모두 고른 것은?',
        stem: `<ol class="combo">${stmts.map((s, i) => `<li><b>${LETTERS[i]}.</b><span>${sentence(s.f, s.v)}</span></li>`).join('')}</ol>`,
        choices: shuffle([ans, ...wrongs]).map((k) => ({ html: k, correct: k === ans })),
        answerHTML: `옳은 것은 <mark class="ok">${ans}</mark>`,
        detail: {
          label: '보기별 판정',
          html: `<ul class="verdicts">${stmts.map((s, i) => `
            <li><b>${LETTERS[i]}</b>${s.isTrue
              ? '<span class="v-true">옳음</span>'
              : `<span class="v-false">틀림</span><span>${esc(s.v)} → ${correctSentence(s.f)}</span>`}</li>`).join('')}</ul>`,
        },
      };
    }

    // pickTrue / pickFalse : 같은 과목의 다른 개념 3개와 섞어 4지선다를 만든다
    const wantTrue = type === 'pickTrue';
    const others = shuffle(pool.filter((f) => f.id !== fact.id)).slice(0, 3);
    const items = [
      { f: fact, isTrue: wantTrue },
      ...others.map((f) => ({ f, isTrue: !wantTrue })),
    ];
    return {
      ...base,
      prompt: wantTrue ? '다음 중 옳은 것은?' : '다음 중 옳지 않은 것은?',
      stem: '',
      choices: shuffle(items).map(({ f, isTrue }) => {
        const v = isTrue ? f.a : pick(f.w);
        return {
          html: sentence(f, v),
          correct: f.id === fact.id,
          statementTrue: isTrue,
          // 틀린 보기는 고쳐진 문장을, 옳은 보기는 그대로 옳다고 알려 준다
          note: isTrue ? '옳은 설명입니다.' : `바르게 고치면 → ${correctSentence(f)}`,
          wrongValue: isTrue ? null : v,
          factId: f.id,
        };
      }),
    };
  }

  // 계산형: CALCS 항목의 gen() 으로 매번 새 숫자를 만든다
  function makeCalc(c) {
    const g = c.gen();
    return {
      type: 'calc',
      fact: c,
      prompt: '다음을 계산하면?',
      stem: esc(g.stem),
      choices: shuffle([g.a, ...g.w]).map((v) => ({ html: esc(v), correct: v === g.a })),
      answerHTML: `${esc(c.name)} = <mark class="ok">${esc(g.a)}</mark>`,
      detail: { label: '풀이', html: `<p class="formula">${esc(c.formula)}</p><p class="solve">${esc(g.solve)}</p>` },
    };
  }

  return { TYPES, make, makeCalc, shuffle, pick, esc };
})();
