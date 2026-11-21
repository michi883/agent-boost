(() => {
  'use strict';

  // Slides render at a fixed 1280x720 and are scaled to fit, so both panels lay out identically.
  const SLIDE_WIDTH = 1280;
  const POLL_MS = 400;
  const DEFAULTS = { slide: 'Create a 2027 go-to-market roadmap slide', build: 'Add interactive 3D visualization to slides' };
  const IDLE = { state: 'idle', steps: [], stages: {} };
  const FEATURE_LABELS = { three_d: '3D', interactive: 'Interactive', colorful: 'Colorful', animated: 'Animated' };
  // Step 2's stages; 'name' runs in parallel with 'code'.
  const STAGES = [
    ['decide', 'Decide', 'decide'],
    ['code', 'Design & code', 'code'],
    ['name', 'Name & describe', 'name'],
    ['test', 'Test in a browser', null],
    ['install', 'Install', null],
  ];

  const $ = (id) => document.getElementById(id);
  const ui = {
    action: $('action'), kicker: $('action-kicker'), title: $('action-title'), notice: $('action-notice'),
    form: $('action-form'), input: $('action-input'), desc: $('action-desc'), button: $('action-button'), alt: $('action-alt'),
    run: $('action-run'), detail: $('action-detail'), time: $('action-time'), newRun: $('new-run'),
    stage: document.querySelector('.stage'), evalView: document.querySelector('.eval-view'),
  };
  const progress = Object.fromEntries(
    [...document.querySelectorAll('.pstep')].map((el) => [el.dataset.step, { el, dot: el.querySelector('.pdot'), time: el.querySelector('.ptime') }])
  );
  const panels = Object.fromEntries(
    [...document.querySelectorAll('.panel')].map((el) => {
      const q = (selector) => el.querySelector(selector);
      return [el.dataset.panel, {
        key: el.dataset.panel, src: el.dataset.src, viewport: q('.viewport'), empty: q('.empty'), frame: q('.slide-frame'),
        live: q('.live'), liveHead: q('.live-head'), stages: q('.stages'), milestones: q('.milestones'),
        card: q('.tool-card'), details: q('.details'), toggle: q('.details-toggle'), sub: q('.panel-sub'),
        signature: undefined, liveKey: '', detailsKey: '', cardKey: '', showDetails: false,
      }];
    })
  );

  let status = null;
  // Runs started at or after `since` (server time) belong to what this page shows. On load it is "now" (a clean start)
  // unless something is running, in which case the page reconnects to the current run.
  let since = null;
  let offset = 0; // server clock minus browser clock
  let busy = false; // a request from this page is in flight
  let clientError = '';
  let inputFor = null;
  let showSlides = false; // after an evaluation: the slides instead of the results table
  const requests = { ...DEFAULTS };
  let ticker = null;

  const now = () => Date.now() + offset;
  const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const elapsed = (job) => secs((job.state === 'running' ? now() : job.finishedAt) - job.startedAt);
  const latest = (job, fallback) => (job.steps?.length ? job.steps[job.steps.length - 1].text : fallback);
  const inRun = (job) => (job && job.startedAt != null && since != null && job.startedAt >= since ? job : IDLE);
  const el = (tag, props, ...children) => {
    const node = Object.assign(document.createElement(tag), props || {});
    node.append(...children.filter((c) => c != null && c !== false));
    return node;
  };
  // Agent names carry their own mark and color everywhere: Gemma (local) teal ●, Gemini violet ✦.
  const agent = (who, text) => el('span', { className: `agent ${who}`, textContent: text });
  const toolChip = (name) => el('code', { className: 'tool-name', textContent: `${name}()` });
  // Fills an element from parts: strings, nodes, or [who, text] for an agent name.
  const fill = (node, parts) => node.replaceChildren(...parts.filter((p) => p != null && p !== false).map((p) => (Array.isArray(p) ? agent(...p) : p)));

  function view() {
    const s1 = inRun(status.gemma.slide);
    const s2 = inRun(status.build);
    const s3 = inRun(status.gemma.tool);
    const ev = inRun(status.evaluation);
    // The tool of this run only (never one from an earlier run): installed, with the name Gemini gave it.
    const tool = s2.state === 'done' && status.build.tool && status.tools.includes(status.build.tool.name) ? status.build.tool : null;
    const running = [['slide', s1], ['build', s2], ['tool', s3], ['eval', ev]].find(([, job]) => job.state === 'running')?.[0] || null;
    const step = running || (s1.state !== 'done' ? 'slide' : !tool ? 'build' : s3.state !== 'done' ? 'tool' : 'finished');
    const models = status.build.models;
    return { s1, s2, s3, ev, tool, running, step, models, features: s2.decision?.features || [] };
  }

  // --- Progress indicators ---
  function renderProgress({ s1, s2, s3, tool, step }) {
    const jobs = { slide: s1, build: s2, tool: s3 };
    for (const [name, p] of Object.entries(progress)) {
      const job = jobs[name];
      const done = name === 'build' ? Boolean(tool) : job.state === 'done';
      const state =
        job.state === 'running' ? 'running'
          : done ? 'done'
          : job.state === 'error' || job.state === 'rejected' ? job.state
          : step === name ? 'current'
          : 'pending';
      p.el.dataset.state = state;
      p.dot.textContent = state === 'done' ? '✓' : { slide: '1', build: '2', tool: '3' }[name];
      p.time.textContent = state === 'running' || state === 'done' ? elapsed(job) : '';
    }
  }

  // --- The one action area ---
  function renderAction(v) {
    const { s1, s2, s3, ev, tool, step, running, models } = v;
    ui.action.dataset.owner = step === 'build' ? 'gemini' : 'gemma';
    let notice = clientError;
    let warn = false;

    if (running) {
      const job = { slide: s1, build: s2, tool: s3, eval: ev }[running];
      ui.form.hidden = true;
      ui.run.hidden = false;
      fill(ui.kicker, {
        slide: ['Step 1 of 3 · ', ['gemma', 'Gemma 31B'], ', running locally'],
        build: ['Step 2 of 3 · ', ['gemini', models.code.name], ' + ', ['gemini', models.name.name]],
        tool: ['Step 3 of 3 · ', ['gemma', 'Gemma 31B'], ', running locally'],
        eval: ['Evaluation · ', ['gemma', 'Gemma 31B'], ' alone vs. with ', ev.tool && toolChip(ev.tool)],
      }[running]);
      fill(ui.title, {
        slide: [['gemma', 'Gemma'], ' is writing your slide'],
        build: [['gemini', 'Gemini'], ' is building ', ['gemma', 'Gemma'], ' a reusable tool'],
        tool: [['gemma', 'Gemma'], ' redoes its slide, with the new tool available'],
        eval: ['Testing the tool on unseen slide requests'],
      }[running]);
      ui.detail.textContent = running === 'build' ? buildDetail(s2, models) : running === 'eval' ? ev.now || 'Starting…' : latest(job, 'Starting…');
      ui.time.textContent = elapsed(job);
      ui.notice.hidden = true;
      return;
    }

    ui.form.hidden = false;
    ui.run.hidden = true;
    const meta = {
      slide: { kicker: ['Step 1 of 3 · ', ['gemma', 'Gemma 31B'], ', running locally on this laptop'], title: ['What slide should ', ['gemma', 'Gemma'], ' make?'], button: 'Create slide', input: 'slide' },
      build: { kicker: ['Step 2 of 3 · ', ['gemini', models.decide.name], ` → ${models.code.name.replace('Gemini ', '')} + ${models.name.name.replace('Gemini ', '')}`], title: ['What capability should ', ['gemini', 'Gemini'], ' give ', ['gemma', 'Gemma'], '?'], button: 'Build tool', input: 'build' },
      tool: {
        kicker: ['Step 3 of 3 · ', ['gemma', 'Gemma 31B'], ', running locally'],
        title: ['Will ', ['gemma', 'Gemma'], ' use its new tool?'],
        button: 'Try with new tool',
        desc: tool && ['Gemma redoes the same slide. It now sees ', toolChip(tool.name), ' among its tools and decides on its own whether to call it.'],
      },
      finished: { kicker: ['Run results'] },
    }[step];

    if (step === 'finished') {
      const calls = s3.summary?.toolCalls || [];
      const differences = s3.summary?.contentDifferences || [];
      const used = calls.length && tool && calls[0].name === tool.name;
      meta.title = used ? [['gemma', 'Gemma'], ' called ', toolChip(tool.name), ' on its own'] : [['gemma', 'Gemma'], ' answered without the tool'];
      meta.desc = [
        used ? (differences.length ? `${differences.length} text changes · ` : 'Same text ✓ · ') : '',
        ['gemma', 'Gemma'], ` ${elapsed(s1)} → `, ['gemini', 'Gemini'], ` ${elapsed(s2)} → `, ['gemma', 'Gemma'], ` ${elapsed(s3)}`,
        v.features.includes('three_d') && used ? ' · Drag the slide to orbit' : '',
      ];
      const evaluated = ev.state === 'done' || ev.state === 'error';
      meta.button = evaluated ? (showSlides ? 'Show test results' : 'Show slides') : `Test on ${status.evaluationSize} unseen requests`;
      if (evaluated && ev.state === 'error') notice = `Evaluation stopped: ${ev.error}`;
    }
    if (!notice) {
      if (step === 'slide' && s1.state === 'error') notice = `Gemma could not make the slide: ${s1.error}`;
      if (step === 'build' && s2.state === 'rejected') {
        notice = `Not supported: ${s2.error} Try a different request.`;
        warn = true;
      }
      if (step === 'build' && s2.state === 'error') notice = `The tool could not be built: ${s2.error}`;
      if (step === 'tool' && s3.state === 'error') notice = `Gemma's retry failed: ${s3.error}`;
    }

    fill(ui.kicker, meta.kicker);
    fill(ui.title, meta.title || []);
    ui.notice.hidden = !notice;
    ui.notice.textContent = notice;
    ui.notice.title = notice;
    ui.notice.classList.toggle('warn', warn);
    ui.input.hidden = !meta.input;
    ui.desc.hidden = Boolean(meta.input);
    fill(ui.desc, meta.desc || []);
    if (meta.input && inputFor !== step) {
      inputFor = step;
      ui.input.value = requests[meta.input];
    }
    if (!meta.input) inputFor = null;
    ui.button.textContent = meta.button;
    ui.button.disabled = busy || (meta.input && !ui.input.value.trim());
    ui.alt.hidden = true;
  }

  // One line for the running build: the stage, its model, and what it is doing.
  function buildDetail(job, models) {
    const stage = STAGES.find(([key]) => key === job.phase);
    if (!stage) return latest(job, 'Starting…');
    if (job.phase === 'code' && job.stages?.name?.running) return `Design & code · ${models.code.name} · ${job.lines ? `${job.lines} lines · ` : ''}${models.name.name} naming it in parallel`;
    const model = stage[2] && models[stage[2]].name;
    const extra = job.phase === 'code' && job.lines ? ` · ${job.lines} lines` : job.phase === 'code' && job.repairs ? ` · repair ${job.repairs}` : '';
    return `${stage[1]}${model ? ` · ${model}` : ''}${extra}`;
  }

  // --- Slide panels ---
  function apply(panel, signature) {
    if (signature === panel.signature) return;
    panel.signature = signature;
    panel.frame.src = signature ? `${panel.src}?v=${encodeURIComponent(signature)}` : 'about:blank';
    panel.frame.hidden = !signature;
  }

  // Step 2's stages: model, state and measured time each.
  function stageRows(job, models) {
    return STAGES.map(([key, label, modelKey]) => {
      const s = job.stages?.[key];
      const state = s?.running ? (job.state === 'running' ? 'current' : 'failed') : s ? (job.state === 'error' && job.phase === key ? 'failed' : 'done') : job.state === 'rejected' || job.state === 'error' ? 'skipped' : '';
      const model = modelKey ? models[modelKey].name : key === 'test' ? 'headless Chrome' : 'tools/';
      const note =
        key === 'code' && job.lines ? `${job.lines} lines${job.repairs ? ` · ${job.repairs} repair${job.repairs > 1 ? 's' : ''}` : ''}`
          : key === 'decide' && job.decision ? `${job.decision.supported ? 'supported' : 'not supported'} ${Math.round(job.decision.confidence * 100)}%`
          : key === 'name' && job.proposed?.name ? `${job.proposed.name}()`
          : key === 'name' && s?.running ? 'in parallel'
          : '';
      return { state: job.state === 'rejected' && key === 'decide' && job.decision && !job.decision.supported ? 'failed' : state, label, model, note, time: s ? secs(s.ms) : '' };
    });
  }

  function renderLive(panel, job, head, stages) {
    panel.live.dataset.owner = stages ? 'gemini' : 'gemma';
    panel.live.classList.toggle('running', job.state === 'running');
    fill(panel.liveHead, [el('span', null, ...head.map((p) => (Array.isArray(p) ? agent(...p) : p)))]);
    const rows = [...job.steps];
    if (job.state === 'error') rows.push({ at: job.finishedAt - job.startedAt, text: `Failed: ${job.error}` });
    const key = JSON.stringify([job.startedAt, job.state, rows.length, rows[rows.length - 1]?.text, stages]);
    if (key === panel.liveKey) return;
    panel.liveKey = key;
    panel.stages.hidden = !stages;
    panel.stages.replaceChildren(
      ...(stages || []).map((s) => el('li', { className: s.state }, el('b', { textContent: s.label }), el('span', { className: 'stage-model', textContent: s.model }), el('span', { className: 'stage-note', textContent: s.note }), el('time', { textContent: s.time })))
    );
    panel.milestones.replaceChildren(
      ...rows.map((row, i) => {
        const li = el('li');
        if (/^(Failed|Test failed|Not supported)/.test(row.text)) li.className = 'failed';
        else if (job.state === 'running' && i === rows.length - 1) li.className = 'current';
        li.append(el('time', { textContent: secs(row.at) }), row.text);
        return li;
      })
    );
  }

  function renderToolCard(panel, job, tool, models) {
    const key = JSON.stringify([job.startedAt, job.finishedAt, tool.name]);
    if (key === panel.cardKey) return;
    panel.cardKey = key;
    const tests = job.tests || [];
    const checks = [
      `${models.decide.name}: supported (${Math.round(job.decision.confidence * 100)}%)`,
      `Built in ${elapsed(job)} · ${job.lines} lines`,
      `Passed on ${tests.map((t) => (t.key === 'slide' ? 'your slide' : 'an unseen topic')).join(' and ')}`,
      ...(tests[0]?.values || []).slice(3),
      ...(job.repairs ? [`Fixed after ${job.repairs} failed test${job.repairs > 1 ? 's' : ''}`] : []),
    ];
    fill(panel.card.querySelector('.tool-card-name'), [toolChip(tool.name)]);
    panel.card.querySelector('.tool-card-request').textContent = `Built from your request: “${job.request}”`;
    panel.card.querySelector('.tool-card-desc').textContent = tool.description;
    panel.card.querySelector('.tool-card-checks').replaceChildren(...checks.map((text) => el('li', { textContent: text })));
    fill(panel.card.querySelector('.tool-card-next'), [['gemma', 'Gemma'], ' has not seen it yet. In step 3 it finds ', toolChip(tool.name), ' among its tools and decides for itself whether to use it.']);
  }

  // Technical log for a panel (secondary; opened with Details).
  function renderDetails(panel, sections) {
    const key = JSON.stringify(sections);
    if (key === panel.detailsKey) return;
    panel.detailsKey = key;
    const nodes = [];
    for (const section of sections) {
      nodes.push(el('h3', { textContent: section.title }));
      const dl = el('dl');
      for (const [term, value] of section.facts.filter(([, value]) => value != null && value !== '')) dl.append(el('dt', { textContent: term }), el('dd', { textContent: value }));
      nodes.push(dl);
      nodes.push(el('ol', null, ...section.steps.map((row) => el('li', null, el('time', { textContent: secs(row.at) }), row.text))));
      if (section.code) nodes.push(el('pre', { textContent: section.code }));
    }
    panel.details.replaceChildren(...nodes);
  }

  function gemmaSection(title, job) {
    const s = job.summary || {};
    const calls = s.toolCalls || [];
    return {
      title,
      facts: [
        ['Request', job.request],
        ['Model', 'Gemma 31B (local llama.cpp, thinking off)'],
        ['State', job.state === 'running' ? `running · ${elapsed(job)}` : `${job.state}${job.finishedAt ? ` · ${elapsed(job)}` : ''}`],
        ['Tokens', s.completionTokens != null ? `${s.completionTokens} generated · first token ${s.firstTokenMs} ms` : null],
        ['Tools offered', s.toolsOffered?.join(', ')],
        ['Tool calls', s.toolsOffered ? calls.map((c) => c.name).join(', ') || 'none' : null],
        ['Content check', s.contentDifferences ? (s.contentDifferences.length ? s.contentDifferences.join('; ') : 'same text as the original slide') : null],
        ['Error', job.error],
      ],
      steps: job.steps,
      code: calls.length ? calls.map((c) => `${c.name}(${(() => { try { return JSON.stringify(JSON.parse(c.arguments), null, 2); } catch { return c.arguments; } })()})`).join('\n') : null,
    };
  }

  function buildSection(job, models) {
    const d = job.decision;
    return {
      title: 'Step 2 · Gemini builds the tool',
      facts: [
        ['Request', job.request],
        ['State', job.state === 'running' ? `running · ${elapsed(job)}` : `${job.state}${job.finishedAt ? ` · ${elapsed(job)}` : ''}`],
        ['Decision', d && `${models.decide.name} (${models.decide.id}, ${models.decide.via}): ${d.supported ? 'supported' : 'not supported'}, confidence ${d.confidence.toFixed(3)}; capabilities ${Object.entries(d.scores).map(([k, p]) => `${FEATURE_LABELS[k]} ${p.toFixed(2)}`).join(', ')}`],
        ['Code', job.stages?.code && `${models.code.name} (${models.code.id}, thinking ${models.code.thinking}, ${models.code.via}) · ${job.lines} lines`],
        ['Name', job.stages?.name && `${models.name.name} (${models.name.id}, thinking ${models.name.thinking}, ${models.name.via})${job.proposed ? ` proposed ${job.proposed.name}()` : ''}`],
        ['Tool', job.tool && `${job.tool.name}() · ${job.tool.description}`],
        ['Verified', job.state === 'done' ? ['base checks', ...job.verified.map((key) => FEATURE_LABELS[key])].join(', ') : null],
        ['Stage times', STAGES.filter(([key]) => job.stages?.[key]).map(([key, label]) => `${label} ${secs(job.stages[key].ms)}`).join(' · ')],
        ...(job.tests || []).map((t) => [`Test: ${t.label}`, `${t.failure ? `failed: ${t.failure}` : 'passed'} · ${t.values.join(', ')}`]),
        ['Reason', job.state === 'rejected' || job.state === 'error' ? job.error : null],
      ],
      steps: job.steps,
    };
  }

  function renderPanels(v) {
    const { s1, s2, s3, tool, models } = v;
    const left = panels.original;
    const right = panels.tool;

    // Left: Gemma's original slide (or its live progress).
    const leftMode = s1.state === 'running' || s1.state === 'error' ? 'live' : s1.state === 'done' ? 'slide' : 'empty';
    left.sub.textContent = s1.request ? `“${s1.request}”` : '';
    left.sub.title = left.sub.textContent;
    if (leftMode === 'live') renderLive(left, s1, s1.state === 'running' ? [['gemma', 'Gemma 31B'], ' is writing the slide'] : [['gemma', 'Gemma 31B'], ' could not make the slide']);
    showMode(left, leftMode, s1.state !== 'idle' && [gemmaSection('Step 1 · Gemma creates the slide', s1)]);

    // Right: the improved slide; before that, Gemini's build, the installed tool, or Gemma's retry in progress.
    right.el ||= right.viewport.closest('.panel');
    fill(right.el.querySelector('.who'), [['gemma', 'Gemma 31B'], ' + ', tool ? toolChip(tool.name) : el('code', { className: 'tool-name', textContent: 'new tool' })]);
    let rightMode = 'empty';
    if (s3.state === 'done') rightMode = 'slide';
    else if (s3.state === 'running' || s3.state === 'error') {
      rightMode = 'live';
      renderLive(right, s3, s3.state === 'running' ? [['gemma', 'Gemma 31B'], ' is redoing its slide, with ', toolChip(tool.name), ' available'] : [['gemma', 'Gemma 31B'], ' could not redo its slide']);
    } else if (s2.state === 'running' || s2.state === 'error' || s2.state === 'rejected') {
      rightMode = 'live';
      const head = {
        running: [['gemini', 'Gemini'], ' is building a reusable tool'],
        error: [['gemini', 'Gemini'], ' could not build a working tool'],
        rejected: [['gemini', 'Gemini'], ' declined: not something a slide tool can do'],
      }[s2.state];
      renderLive(right, s2, head, stageRows(s2, models));
    } else if (tool) {
      rightMode = 'card';
      renderToolCard(right, s2, tool, models);
    }
    right.sub.textContent = ''; // the request is on the tool card, the result line and in Details
    const sections = [];
    if (s2.state !== 'idle') sections.push(buildSection(s2, models));
    if (s3.state !== 'idle') sections.push(gemmaSection('Step 3 · Gemma uses the tool', s3));
    showMode(right, rightMode, sections.length && sections);
  }

  function showMode(panel, mode, sections) {
    apply(panel, mode === 'slide' ? status[panel.key] : null);
    panel.empty.hidden = mode !== 'empty';
    panel.live.hidden = mode !== 'live';
    if (panel.card) panel.card.hidden = mode !== 'card';
    panel.toggle.hidden = !sections;
    if (!sections) panel.showDetails = false;
    panel.toggle.setAttribute('aria-pressed', String(panel.showDetails));
    panel.toggle.textContent = panel.showDetails ? 'Close details' : 'Details';
    panel.details.hidden = !panel.showDetails;
    if (panel.showDetails && sections) renderDetails(panel, sections);
  }

  // --- Evaluation: a compact table, Gemma alone vs. Gemma with the tool, measured per task ---
  let evalKey = '';
  function renderEvaluation(v) {
    const { ev } = v;
    const visible = ev.state !== 'idle' && !showSlides;
    ui.evalView.hidden = !visible;
    ui.stage.classList.toggle('show-eval', visible);
    if (!visible) return;
    const key = JSON.stringify([ev.startedAt, ev.state, ev.tasks]);
    if (key === evalKey) return;
    evalKey = key;
    const features = ev.features || [];
    fill(ui.evalView.querySelector('h2'), ['Does ', toolChip(ev.tool), ' work beyond the original slide?']);
    fill(ui.evalView.querySelector('.eval-sub'), [
      `The original request plus ${ev.tasks.length - 1} unseen slide requests. `, ['gemma', 'Gemma 31B'], ' writes each slide alone, then again with the tool available; every page is measured in a browser.',
    ]);

    // Columns: [title, side, cell(result) -> { pass: true|false|null, text, tip }]
    const yes = (pass, text, tip) => ({ pass, text, tip });
    const common = [
      ['Text', (r, side) => yes(r.shown === r.expected && (side === 'alone' || r.differences === 0), side === 'tool' && r.differences ? `${r.differences} changed` : `${r.shown}/${r.expected}`, side === 'tool' ? 'Every text shown, and the same text as Gemma\'s own slide' : 'Every text of Gemma\'s slide shown')],
      ['In frame', (r) => yes(r.issueCount === 0, r.issueCount ? `${r.issueCount} issue${r.issueCount > 1 ? 's' : ''}` : '', r.issues.join('\n') || 'Nothing cut off or covered')],
      ['No errors', (r) => yes(r.errors.length === 0, r.errors.length ? `${r.errors.length}` : '', r.errors.join('\n') || 'No errors on load')],
      ...features.map((f) => [FEATURE_LABELS[f], (r) => yes(r.features[f].pass, r.features[f].pass ? '' : '', r.features[f].value)]),
      ['Time', (r) => yes(null, secs(r.ms), 'Gemma generation (plus the tool run)')],
    ];
    const columns = [
      ...common.map(([title, fn]) => ({ title, side: 'alone', fn })),
      { title: 'Called', side: 'tool', fn: (r) => yes(r.called === ev.tool, r.called ? '' : 'no', r.called ? `Gemma called ${r.called}()` : 'Gemma wrote the slide itself') },
      ...common.map(([title, fn]) => ({ title, side: 'tool', fn })),
    ];

    const cell = (task, col) => {
      const r = task[col.side];
      if (r.state === 'done') {
        const c = col.fn(r, col.side);
        return el('td', { className: c.pass === null ? 'value' : c.pass ? 'pass' : 'fail', title: c.tip || '' }, c.pass === null ? c.text : `${c.pass ? '✓' : '✗'}${c.text ? ` ${c.text}` : ''}`);
      }
      if (r.state === 'error') return el('td', { className: 'fail', title: r.error }, '✗ error');
      return el('td', { className: 'pending' }, r.state === 'pending' ? '–' : '…');
    };
    const thead = ui.evalView.querySelector('thead');
    const aloneCount = columns.filter((c) => c.side === 'alone').length;
    thead.replaceChildren(
      el('tr', null, el('th', { rowSpan: 2, className: 'task' }, 'Slide request'),
        el('th', { colSpan: aloneCount, className: 'group gemma' }, agent('gemma', 'Gemma'), ' alone'),
        el('th', { colSpan: columns.length - aloneCount, className: 'group gemini' }, agent('gemma', 'Gemma'), ' + ', toolChip(ev.tool))),
      el('tr', null, ...columns.map((c) => el('th', { className: c.side === 'tool' && c.title === 'Called' ? 'first' : '' }, c.title)))
    );
    ui.evalView.querySelector('tbody').replaceChildren(
      ...ev.tasks.map((task) => el('tr', null,
        el('td', { className: 'task', title: task.request }, el('span', { className: `kind${task.unseen ? ' unseen' : ''}`, textContent: task.unseen ? 'Unseen' : 'Original' }), task.request),
        ...columns.map((c) => cell(task, c))))
    );
    // Totals: passes out of finished tasks per check, average time.
    const done = (side) => ev.tasks.map((t) => t[side]).filter((r) => r.state === 'done');
    ui.evalView.querySelector('tfoot').replaceChildren(
      el('tr', null, el('td', { className: 'task' }, 'All tasks'),
        ...columns.map((c) => {
          const rs = done(c.side);
          if (!rs.length) return el('td', { className: 'pending' }, '–');
          const cs = rs.map((r) => c.fn(r, c.side));
          if (cs[0].pass === null) return el('td', { className: 'value' }, `avg ${secs(rs.reduce((sum, r) => sum + r.ms, 0) / rs.length)}`);
          const passed = cs.filter((x) => x.pass).length;
          return el('td', { className: passed === cs.length ? 'pass' : passed ? 'mixed' : 'fail' }, `${passed}/${cs.length}`);
        }))
    );
    // Verdict: tasks that passed every check, per side (only from checks that actually ran).
    const allPass = (side) => done(side).filter((r) => columns.filter((c) => c.side === side).every((c) => c.fn(r, side).pass !== false)).length;
    const total = ev.tasks.length;
    fill(ui.evalView.querySelector('.eval-verdict'), ev.state === 'running'
      ? ['Running… results appear as each slide is measured.']
      : [['gemma', 'Gemma'], ' + ', toolChip(ev.tool), `: ${allPass('tool')}/${total} requests passed every check · `, ['gemma', 'Gemma'], ` alone: ${allPass('alone')}/${total}`, ev.state === 'error' ? ` · stopped: ${ev.error}` : '']);
  }

  function render() {
    if (!status) return;
    const v = view();
    renderProgress(v);
    renderAction(v);
    renderPanels(v);
    renderEvaluation(v);
    ui.newRun.disabled = busy || (!status.active && v.s1.state === 'idle' && !v.running);
    if (v.running && !ticker) ticker = setInterval(render, 100);
    if (!v.running && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  async function refresh() {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) return;
    status = await response.json();
    offset = status.now - Date.now();
    if (since === null) {
      since = status.active ? status.run.startedAt ?? status.now : status.now;
      if (status.active) {
        requests.slide = status.run.request || DEFAULTS.slide;
        requests.build = status.build.request || DEFAULTS.build;
      }
    }
    render();
  }

  async function post(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok && response.status !== 409) throw new Error(`request failed (${response.status})`);
  }

  async function run(action) {
    busy = true;
    clientError = '';
    render();
    try {
      await action();
    } catch (err) {
      clientError = `Could not start: ${err.message === 'Failed to fetch' ? 'server unreachable' : err.message}`;
    } finally {
      busy = false;
      await refresh().catch(() => {});
    }
  }

  function newRun() {
    return run(async () => {
      await post('/api/reset', {});
      Object.assign(requests, DEFAULTS);
      inputFor = null;
      showSlides = false;
      Object.values(panels).forEach((panel) => {
        panel.showDetails = false;
      });
      await refresh();
      since = status.now;
    });
  }

  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || !status) return;
    const { step, ev } = view();
    if (step === 'slide') run(() => post('/api/gemma', { withTools: false, prompt: requests.slide.trim() }));
    else if (step === 'build') run(() => post('/api/improve', { prompt: requests.build.trim() }));
    else if (step === 'tool') run(() => post('/api/gemma', { withTools: true }));
    else if (step === 'finished' && ev.state === 'idle') {
      showSlides = false;
      run(() => post('/api/evaluate', {}));
    } else if (step === 'finished') {
      showSlides = !showSlides;
      render();
    }
  });
  ui.input.addEventListener('input', () => {
    if (inputFor) requests[inputFor] = ui.input.value;
    clientError = '';
    render();
  });
  ui.newRun.addEventListener('click', newRun);
  const arch = $('arch');
  $('arch-open').addEventListener('click', () => arch.showModal());
  $('arch-close').addEventListener('click', () => arch.close());
  arch.addEventListener('click', (event) => {
    if (event.target === arch) arch.close();
  });
  Object.values(panels).forEach((panel) =>
    panel.toggle.addEventListener('click', () => {
      panel.showDetails = !panel.showDetails;
      panel.detailsKey = '';
      render();
    })
  );

  async function poll() {
    try {
      await refresh();
    } catch {
      // Server briefly unavailable; keep showing the last state and retry.
    } finally {
      setTimeout(poll, status?.active ? 150 : POLL_MS);
    }
  }

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      entry.target.querySelector('.slide-frame').style.transform = `scale(${entry.contentRect.width / SLIDE_WIDTH})`;
    }
  });
  Object.values(panels).forEach((panel) => resizeObserver.observe(panel.viewport));

  poll();
})();
