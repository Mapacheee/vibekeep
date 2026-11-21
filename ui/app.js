const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const fragment = new URLSearchParams(location.hash.slice(1));
const tokenKey = `vibekeep-token-${location.port}`;
if (fragment.has('token')) { sessionStorage.setItem(tokenKey, fragment.get('token')); history.replaceState(null, '', location.pathname); }
const token = sessionStorage.getItem(tokenKey) || '';
const state = { workspaces: [], selected: sessionStorage.getItem('vibekeep-workspace') || '', data: null, model: {}, tab: 'preview', file: null, content: null, svg: null, blob: '', htmlUrl: '', dirty: false, edited: '', jobId: null, after: 0, events: [], approvals: [], image: '', loading: false, textAction: null, refreshing: false };
let toastTimer;

function toast(message, error = false) { $('#toast').textContent = message; $('#toast').className = `toast${error ? ' error' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), error ? 9000 : 3500); }
async function api(path, body, raw = false) {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) { let value; try { value = await response.json(); } catch {} throw new Error(value?.error || `Request failed (${response.status}).`); }
  return raw ? response : response.json();
}
const query = (path, values = {}) => `${path}?${new URLSearchParams({ workspace: state.selected, ...values })}`;
const post = (path, body = {}) => api(path, { workspaceId: state.selected, ...body });
const guard = action => async (...args) => { try { await action(...args); } catch (error) { toast(error.message, true); } };
const time = value => new Date(value).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
const nameOf = path => path.split(/[\\/]/).at(-1);

const tabs = [...document.querySelectorAll('[data-tab]')];
const views = [...document.querySelectorAll('.mobile-views [data-view]')];

function setView(view) {
  $('main').dataset.view = view;
  for (const button of views) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  if (view === 'inspector') tabs.find(button => button.dataset.tab === state.tab)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function setTab(tab) {
  state.tab = tab;
  for (const button of tabs) {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected) button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  $('#panel').setAttribute('aria-labelledby', `tab-${tab}`);
  renderPanel();
}

function toggleSidebar(open, restoreFocus = false) {
  $('#sidebar').classList.toggle('open', open);
  $('#menu-button').setAttribute('aria-expanded', String(open));
  if (open) $('#file-search').focus();
  else if (restoreFocus) $('#menu-button').focus();
}

function renderWorkspaces() {
  const list = $('#workspaces');
  const version = JSON.stringify([state.selected, state.workspaces]);
  if (list.dataset.version === version) return;
  list.dataset.version = version;
  list.innerHTML = state.workspaces.map(item => {
    const active = item.id === state.selected;
    const remote = item.kind === 'remote' ? '<small>Remote</small>' : '';
    return `<button class="workspace-item${active ? ' active' : ''}" data-workspace="${escape(item.id)}" ${active ? 'aria-current="true"' : ''} title="${escape(item.name)}"><span class="workspace-name">${escape(item.name)}</span>${remote}</button>`;
  }).join('');
  list.querySelectorAll('[data-workspace]').forEach(button => button.addEventListener('click', guard(async () => {
    if (state.dirty && !confirm('Discard unsaved editor changes?')) return;
    state.selected = button.dataset.workspace;
    sessionStorage.setItem('vibekeep-workspace', state.selected);
    if (state.blob) URL.revokeObjectURL(state.blob);
    Object.assign(state, { file: null, content: null, svg: null, blob: '', dirty: false, image: '', htmlUrl: '' });
    toggleSidebar(false);
    setView('inspector');
    setTab('preview');
    renderAttachment();
    await refreshWorkspace();
    renderWorkspaces();
  })));
}

function fileIcon(file) {
  const extension = nameOf(file.path).match(/\.([\w-]+)$/)?.[1];
  if (extension && extension.length <= 4) return extension.toUpperCase();
  return file.representation === 'binary' ? 'BIN' : 'FILE';
}

function renderFiles() {
  const files = state.data?.inventory.files || [];
  const search = $('#file-search').value.trim().toLowerCase();
  const filtered = files.filter(file => `${file.path} ${file.label || ''}`.toLowerCase().includes(search)).slice(0, 250);
  const list = $('#files');
  const markup = filtered.map(file => {
    const selected = state.file?.path === file.path;
    const directory = file.path.includes('/') ? `<small class="file-directory">${escape(file.path.slice(0, file.path.lastIndexOf('/')))}</small>` : '';
    return `<button class="file-item${selected ? ' selected' : ''}" data-file="${escape(file.path)}" ${selected ? 'aria-current="true"' : ''} title="${escape(file.path)}"><span class="file-icon" aria-hidden="true">${fileIcon(file)}</span><span class="file-path"><span class="file-name">${escape(file.label || nameOf(file.path))}</span>${directory}</span></button>`;
  }).join('') || `<p class="support-note">${search ? 'No matching files.' : 'No files in this workspace.'}</p>`;
  if (list.dataset.markup === markup) return;
  list.dataset.markup = markup;
  list.innerHTML = markup;
  list.querySelectorAll('[data-file]').forEach(button => button.addEventListener('click', guard(async () => {
    if (state.dirty && !confirm('Discard unsaved editor changes?')) return;
    toggleSidebar(false);
    setView('inspector');
    if (state.tab !== 'editor') setTab('preview');
    await selectFile(button.dataset.file, true);
  })));
}

function formatMessage(content) {
  return String(content).split(/(```[\s\S]*?```)/g).map(part => part.startsWith('```') ? `<pre><code>${escape(part.replace(/^```[^\n]*\n?/, '').replace(/```$/, ''))}</code></pre>` : escape(part)).join('');
}

function renderMessages() {
  const container = $('#messages');
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 110;
  const messages = state.data?.messages || [];
  const pending = state.jobId ? '<p class="pending-dots">Working…</p>' : '';
  const entries = messages.map(message => `
    <article class="message${message.role === 'user' ? ' user' : ''}">
      <div class="message-label">${message.role === 'user' ? 'You' : 'VibeKeep'} <time>${time(message.created_at)}</time></div>
      <div class="message-body">${formatMessage(message.content)}</div>
    </article>`).join('');
  const empty = state.data
    ? `<div class="chat-empty"><h2>No messages yet</h2><p>${state.model.configured ? 'Send a message to start.' : 'Set up a model to use chat.'}</p></div>`
    : '<p class="support-note">Opening workspace…</p>';
  const markup = (entries || (state.jobId ? '' : empty)) + pending;
  if (container.dataset.markup === markup) return;
  container.dataset.markup = markup;
  container.innerHTML = markup;
  if (atBottom || state.jobId) container.scrollTop = container.scrollHeight;
}

function setBusy(busy) {
  $('#send-button').classList.toggle('hidden', busy); $('#stop-button').classList.toggle('hidden', !busy);
  $('#prompt').disabled = busy; $('#operation-status').textContent = busy ? 'Working…' : '';
}

function renderExperiment() {
  const active = state.data?.experiments.find(item => item.status === 'active');
  $('#experiment-bar').classList.toggle('hidden', !active);
  if (!active) return;
  $('#experiment-bar').innerHTML = `<span>${escape(active.name)}</span><button id="accept-experiment">Keep changes</button><button id="discard-experiment">Discard</button>`;
  $('#accept-experiment').onclick = guard(async () => { await post('experiment', { action: 'accept', id: active.id }); toast('Experiment kept.'); await refreshWorkspace(); });
  $('#discard-experiment').onclick = guard(async () => { if (!confirm('Revert this experiment’s own file changes? Script and external effects are not reversed.')) return; await post('experiment', { action: 'discard', id: active.id }); toast('Experiment file changes reverted.'); await refreshWorkspace(true); });
}

function renderApprovals() {
  const approval = state.approvals.find(item => item.workspaceId === state.selected);
  $('#approval').classList.toggle('hidden', !approval);
  if (!approval || $('#approval').dataset.id === approval.id) return;
  $('#approval').dataset.id = approval.id;
  $('#approval').innerHTML = `<strong>Allow this task to run?</strong><pre>${escape(approval.description)}</pre><label class="checkbox-label"><input id="remember-approval" type="checkbox">Allow this task for the rest of this session</label><div class="actions"><button class="button primary" id="approve-task">Allow task</button><button class="button" id="deny-task">Decline</button></div>`;
  for (const [id, approved] of [['approve-task', true], ['deny-task', false]]) $(`#${id}`).onclick = guard(async () => { await api('approval', { id: approval.id, approved, remember: $('#remember-approval').checked }); $('#approval').classList.add('hidden'); $('#approval').dataset.id = ''; });
}

function emptyPanel(title, description = '') {
  return `<div class="empty-panel"><h3>${escape(title)}</h3>${description ? `<p>${escape(description)}</p>` : ''}</div>`;
}

function renderSummary() {
  const { inventory, tasks } = state.data;
  const count = inventory.files.length;
  const info = [
    ['Location', inventory.root],
    ['Files', count],
    ['Tasks', `${tasks.filter(task => task.available).length} available`]
  ];
  return emptyPanel(count ? 'Select a file' : 'No files yet', count ? 'Choose a file from the sidebar to open it.' : 'Create a file or send a message to get started.')
    + `<dl class="workspace-facts">${info.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`
    + (inventory.truncated ? '<p class="support-note">Some large files have metadata only.</p>' : '');
}

function renderPreview() {
  if (!state.file) return renderSummary();
  const file = state.file;
  const toolbar = `<div class="preview-toolbar"><span class="preview-title">${escape(file.label || file.path)}</span>${file.representation !== "binary" && state.content ? `<button class="button" id="edit-resource">${state.content.editable === false ? "View source" : "Edit source"}</button>` : ""}</div>`;
  let content;
  if (state.loading) content = emptyPanel('Loading file…');
  else if (state.blob && (file.mediaType?.startsWith('image/') || file.path.endsWith('.svg'))) content = `<div class="preview-surface"><img src="${state.blob}" alt="${escape(file.path)}"></div>`;
  else if (state.htmlUrl) content = `<div class="preview-surface"><iframe src="${escape(state.htmlUrl)}" title="${escape(file.path)} preview" sandbox="allow-scripts allow-same-origin allow-forms"></iframe></div>`;
  else if (state.blob && file.mediaType === 'application/pdf') content = `<div class="preview-surface"><iframe src="${state.blob}" title="PDF preview"></iframe></div>`;
  else if (state.content) content = `<pre class="preview-text">${escape(state.content.content)}</pre>`;
  else content = emptyPanel('Metadata available', 'This resource needs a format-specific editor or a connected application to inspect its contents.', '▧');
  const meta = `<p class="support-note">${escape(file.mediaType || 'Resource')} · ${(file.bytes / 1024).toFixed(1)} KiB · ${escape(file.representation || 'text')} representation</p>`;
  const svg = state.svg ? `<div class="card"><div class="card-title">SVG properties</div><label class="panel-subtitle">Element <select id="svg-node" class="svg-control"><option value="$root">Root SVG</option>${state.svg.nodes.map(node => `<option value="${escape(node.id)}">${escape(node.tag)} #${escape(node.id)}</option>`).join('')}</select></label><div class="memory-input"><select id="svg-property" class="svg-control" aria-label="SVG property"><option value="fill">Fill</option><option value="stroke">Stroke</option><option value="opacity">Opacity</option><option value="width">Width</option><option value="height">Height</option><option value="x">X</option><option value="y">Y</option></select><input id="svg-value" placeholder="#167a70" aria-label="SVG property value"><button class="button primary" id="apply-svg">Apply</button></div></div>` : '';
  return toolbar + content + meta + svg;
}

function renderMemory() {
  return `<div class="panel-heading"><div><h2>Saved decisions</h2></div><button class="button" id="export-memory">Export</button></div><form id="memory-form" class="memory-input"><input id="memory-statement" required placeholder="Remember a decision…" aria-label="Decision to remember"><button type="submit" class="button primary">Keep</button></form><div class="preview-toolbar"><span class="panel-subtitle">${state.data.decisions.length} current decisions</span><button class="button quiet" id="import-memory">Import</button><input class="hidden" type="file" id="memory-upload" accept="application/json"></div>${state.data.decisions.map(decision => `<article class="card"><div class="card-title"><span class="badge ${decision.status}">${escape(decision.status)}</span><span class="panel-subtitle">${escape(decision.area)}</span></div><p>${escape(decision.statement)}</p><small>${escape(decision.authority.replaceAll('_', ' '))} · ${time(decision.created_at)}</small>${decision.status === 'proposed' ? `<div class="actions"><select class="supersedes svg-control" aria-label="Decision to replace"><option value="">Keep other decisions</option>${state.data.decisions.filter(old => old.status === 'accepted').map(old => `<option value="${escape(old.id)}">Replace: ${escape(old.statement.slice(0, 55))}</option>`).join('')}</select><button class="button primary" data-accept="${escape(decision.id)}">Accept</button></div>` : ''}</article>`).join('') || emptyPanel('No saved decisions')}`;
}

function renderTasks() {
  const servers = state.data.servers || [];
  const header = `<div class="panel-heading"><div><h2>Workspace tasks</h2></div>${state.data.kind === 'local' ? '<button class="button" id="add-task">+ Add task</button>' : '<span class="badge">Application connector</span>'}</div>`;
  return header + `${servers.length ? `<div class="section-label">DEVELOPMENT SERVERS</div>${servers.map(server => `<article class="card"><div class="card-title">${escape(server.label)}<span class="badge ${server.status}">${server.ready ? 'Ready' : escape(server.status)}</span></div>${server.url ? `<p>${escape(server.url)}</p>` : '<p>Waiting for a local preview URL in the output…</p>'}<div class="actions">${server.url && server.status === 'running' ? `<button class="button" data-server-preview="${escape(server.url)}">Open preview</button>` : ''}${['starting', 'running'].includes(server.status) ? `<button class="button danger" data-stop-server="${escape(server.id)}">Stop server</button>` : ''}</div>${server.logs ? `<pre class="code-output">${escape(server.logs.slice(-6000))}</pre>` : ''}</article>`).join('')}` : ''}${state.data.tasks.map(task => `<article class="card"><div class="card-title">${escape(task.label)}<span class="badge ${task.available ? '' : 'stale'}">${task.available ? 'Available' : 'Unavailable'}</span></div><small>${escape(task.provider)} · ${escape(task.mode)} · ${escape(task.recovery || task.cwd)}</small><p class="task-command">${escape(task.description || `${task.command} ${task.args.join(' ')}`)}</p>${task.reason ? `<small>${escape(task.reason)}</small>` : ''}<div class="actions"><button class="button ${task.available ? 'primary' : ''}" data-run-task="${escape(task.id)}" ${!task.available || state.jobId ? 'disabled' : ''}>${task.mode === 'server' ? 'Start server' : task.provider === 'remote' ? 'Run operation' : 'Run task'}</button></div></article>`).join('') || emptyPanel('No tasks available', state.data.kind === 'local' ? 'Add a task to run a tool from this workspace.' : '')}<button class="button quiet" id="show-checks">View results</button><div id="checks-results"></div>`;
}

function renderChanges() {
  return `<div class="panel-heading"><div><h2>File changes</h2></div></div>${state.data.changes.map(change => `<article class="card"><div class="card-title">${escape(change.path)}<span class="badge ${change.currentMatches ? '' : 'stale'}">${change.currentMatches ? 'Matches' : 'Changed since'}</span></div><div class="actions"><button class="button" data-diff="${escape(change.actionId)}">View changes</button><button class="button" data-undo="${escape(change.actionId)}" ${!change.currentMatches ? 'disabled' : ''}>Undo change</button></div><div id="diff-${escape(change.actionId)}"></div></article>`).join('') || emptyPanel('No file changes')}`;
}

function renderActivity() {
  const timeline = state.data.timeline;
  return `<div class="panel-heading"><div><h2>Activity log</h2></div></div>${timeline.map(event => `<div class="timeline-item"><strong>${escape(event.type.replaceAll('.', ' › '))}</strong><small>${time(event.created_at)} · ${escape(event.scope)}</small><p>${escape(JSON.stringify(event.payload).slice(0, 350))}</p></div>`).join('') || emptyPanel('No activity yet')}`;
}

function renderPanel() {
  if (!state.data) { $('#panel').innerHTML = emptyPanel('Opening workspace…'); return; }
  const memoryValue = $('#memory-statement')?.value || '';
  const scroll = $('#panel').scrollTop;
  if (state.tab === 'preview') $('#panel').innerHTML = renderPreview();
  else if (state.tab === 'editor') $('#panel').innerHTML = !state.file || state.file.representation === 'binary' ? emptyPanel('Select a text resource', 'Native binary assets need their own editor. Text, code, SVG, and structured documents can be edited here.', '⌘') : `<div class="preview-toolbar"><span class="preview-title">${escape(state.file.path)}</span><button class="button primary" id="save-file" ${state.loading || state.content?.truncated ? 'disabled' : ''}>Save changes</button></div>${state.content?.truncated ? '<p class="support-note">This file exceeds the browser editor limit. Use paginated tools or your editor.</p>' : ''}<textarea class="editor" id="editor" spellcheck="false" aria-label="Resource source editor" ${state.content?.truncated ? 'readonly' : ''}>${escape(state.dirty ? state.edited : state.content?.content || '')}</textarea><p class="support-note">Writes check the file revision and keep an undo snapshot.</p>`;
  else if (state.tab === 'memory') $('#panel').innerHTML = renderMemory();
  else if (state.tab === 'tasks') $('#panel').innerHTML = renderTasks();
  else if (state.tab === 'changes') $('#panel').innerHTML = renderChanges();
  else $('#panel').innerHTML = renderActivity();
  $('#panel').scrollTop = scroll;
  if ($('#memory-statement')) $('#memory-statement').value = memoryValue;
  bindPanel();
  if (state.content?.editable === false) { $('#save-file')?.setAttribute('disabled', ''); $('#editor')?.setAttribute('readonly', ''); }
}

function bindPanel() {
  $('#edit-resource')?.addEventListener('click', () => setTab('editor'));
  $('#editor')?.addEventListener('input', event => { state.dirty = true; state.edited = event.target.value; });
  $('#save-file')?.addEventListener('click', guard(async () => { await post('file', { path: state.file.path, content: $('#editor').value, expectedHash: state.content.hash }); state.dirty = false; toast('Changes saved.'); await refreshWorkspace(true); }));
  $('#apply-svg')?.addEventListener('click', guard(async () => { const value = $('#svg-value').value.trim(); if (!value) throw new Error('Enter a property value.'); await post('svg', { path: state.file.path, nodeId: $('#svg-node').value, attributes: { [$('#svg-property').value]: value }, expectedHash: state.content.hash }); toast('Visual property updated.'); await refreshWorkspace(true); }));
  $('#memory-form')?.addEventListener('submit', guard(async event => { event.preventDefault(); await post('memory', { statement: $('#memory-statement').value }); $('#memory-statement').value = ''; await refreshWorkspace(); toast('Decision kept.'); }));
  $('#panel').querySelectorAll('[data-accept]').forEach(button => button.onclick = guard(async () => { const previous = button.parentElement.querySelector('select').value; await post('accept', { id: button.dataset.accept, ...(previous ? { supersedes: previous } : {}) }); await refreshWorkspace(); toast('Decision accepted.'); }));
  $('#export-memory')?.addEventListener('click', guard(async () => { const data = await api(query('export')); const blob = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = blob; a.download = 'vibekeep-memory.json'; a.click(); setTimeout(() => URL.revokeObjectURL(blob), 1000); }));
  $('#import-memory')?.addEventListener('click', () => $('#memory-upload').click());
  $('#memory-upload')?.addEventListener('change', guard(async event => { const file = event.target.files[0]; if (!file) return; const result = await post('import', { memory: JSON.parse(await file.text()) }); toast(`Imported ${result.imported} decisions.`); await refreshWorkspace(); }));
  $('#add-task')?.addEventListener('click', () => $('#task-dialog').showModal());
  $('#panel').querySelectorAll('[data-run-task]').forEach(button => button.onclick = guard(async () => {
    const task = state.data.tasks.find(task => task.id === button.dataset.runTask);
    if (task.inputSchema) { openOperation(task); return; }
    await startTask(task.id);
  }));
  $('#panel').querySelectorAll('[data-stop-server]').forEach(button => button.onclick = guard(async () => { await post('stop', { id: button.dataset.stopServer }); await refreshWorkspace(); toast('Server stopped.'); }));
  $('#panel').querySelectorAll('[data-server-preview]').forEach(button => button.onclick = () => { state.file = { path: 'Live development preview', representation: 'binary', bytes: 0 }; state.htmlUrl = button.dataset.serverPreview; state.blob = ''; state.content = null; state.svg = null; setTab('preview'); });
  $('#panel').querySelectorAll('[data-undo]').forEach(button => button.onclick = guard(async () => { await post('undo', { actionId: button.dataset.undo }); await refreshWorkspace(true); toast('Own file change restored.'); }));
  $('#panel').querySelectorAll('[data-diff]').forEach(button => button.onclick = guard(async () => { const diff = await api(query('diff', { id: button.dataset.diff })); document.getElementById(`diff-${button.dataset.diff}`).innerHTML = `<div class="diff-grid"><pre>${escape(diff.before || '(new file)')}</pre><pre>${escape(diff.after || '(removed file)')}</pre></div>`; }));
  $('#show-checks')?.addEventListener('click', guard(async () => { const checks = await api(query('checks')); $('#checks-results').innerHTML = checks.map(check => `<article class="card"><div class="card-title">${escape(check.status)}<span class="badge ${check.current ? '' : 'stale'}">${check.current ? 'Current revision' : 'Out of date'}</span></div><pre class="code-output">${escape(check.result?.output || JSON.stringify(check.result, null, 2))}</pre></article>`).join('') || '<p class="support-note">No checks have run yet.</p>'; }));
}

async function selectFile(path, force = false) {
  if (state.dirty && !force && !confirm('Discard unsaved editor changes?')) return;
  const file = state.data?.inventory.files.find(file => file.path === path);
  if (!file) { state.file = null; state.content = null; state.dirty = false; state.blob = ''; state.svg = null; state.htmlUrl = ''; renderPanel(); return; }
  if (state.blob) URL.revokeObjectURL(state.blob);
  state.file = file; state.content = null; state.dirty = false; state.svg = null; state.blob = ''; state.htmlUrl = ''; state.loading = true;
  renderFiles(); renderPanel(); $('#resource-status').textContent = file.path;
  try {
    if (file.representation !== 'binary') state.content = await api(query('file', { path, full: '1' }));
    if (state.file?.path !== path) return;
    if (file.mediaType?.startsWith('image/') || file.mediaType === 'application/pdf') {
      const response = await api(query('artifact', { path }), undefined, true);
      state.blob = URL.createObjectURL(await response.blob());
    }
    if (/\.html?$/i.test(path)) state.htmlUrl = (await api(query('preview', { path }))).url;
    if (path.endsWith('.svg')) { try { state.svg = await api(query('svg', { path })); } catch { /* source editing remains available */ } }
  } finally { state.loading = false; renderPanel(); }
}

async function refreshWorkspace(reloadSelected = false) {
  if (!state.selected || state.refreshing) return;
  state.refreshing = true;
  try {
    const id = state.selected;
    const data = await api(query('workspace'));
    if (id !== state.selected) return;
    const changed = state.file && data.inventory.files.find(file => file.path === state.file.path)?.hash !== state.file.hash;
    state.data = data;
    $('#workspace-title').textContent = data.name; $('#scope').textContent = data.inventory.branch;
    $('#resource-status').textContent = state.file?.label || state.file?.path || '';
    $('#experiment-button').disabled = data.kind !== 'local'; $('#new-file').disabled = data.kind !== 'local';
    renderFiles(); renderMessages(); renderExperiment();
    if ((reloadSelected || changed) && state.file && !state.dirty) await selectFile(state.file.path, true);
    else renderPanel();
  } finally { state.refreshing = false; }
}

async function poll() {
  try {
    const result = await api(`state?after=${state.after}`);
    state.workspaces = result.workspaces; state.model = result.model; state.approvals = result.approvals;
    state.events.push(...result.events); state.events = state.events.slice(-100);
    if (result.events.length) state.after = result.events.at(-1).seq;
    if (!state.selected || !state.workspaces.some(workspace => workspace.id === state.selected)) state.selected = state.workspaces[0]?.id || '';
    $('#model-label').textContent = result.model.configured ? result.model.model || 'Model ready' : 'Set up model';
    $('#model-button').classList.toggle('ready', result.model.configured);
    renderWorkspaces(); renderApprovals(); renderMessages();
    if (!state.data) await refreshWorkspace();
    if (state.jobId) {
      const job = await api(`jobs?id=${encodeURIComponent(state.jobId)}`);
      if (job.status !== 'running') {
        state.jobId = null; setBusy(false); state.image = ''; renderAttachment();
        if (job.error) toast(job.error, true);
        else if (job.kind === 'Task') {
          const result = job.result;
          toast(result?.exitCode !== undefined ? `Task finished with exit code ${result.exitCode}.` : ['starting', 'running'].includes(result?.status) ? 'Development process started.' : 'Operation completed.');
        }
        await refreshWorkspace(true);
        $('#messages').scrollTop = $('#messages').scrollHeight;
      } else {
        const event = state.events.filter(event => event.workspaceId === state.selected).at(-1);
        if (event) $('#operation-status').textContent = event.message.slice(0, 100);
        if (!state.data.messages.length) { state.data.messages = (await api(query('workspace'))).messages; renderMessages(); }
      }
    }
    $('#connection-status').textContent = state.data?.connection?.connected === false ? 'Disconnected · cached data' : state.data?.kind === 'remote' ? 'Connected' : 'Local workspace';
  } catch (error) { $('#connection-status').textContent = 'Connection unavailable'; if (!state.data) toast(error.message, true); }
  setTimeout(poll, 900);
}

function renderAttachment() {
  $('#attachment').classList.toggle('hidden', !state.image);
  if (state.image) { $('#attachment').innerHTML = `▧ ${escape(state.image)} <button id="remove-attachment">× Remove</button>`; $('#remove-attachment').onclick = () => { state.image = ''; renderAttachment(); }; }
}

function openSettings() {
  $('#provider').value = state.model.provider || 'compatible'; $('#model-id').value = state.model.model || '';
  $('#endpoint').value = state.model.baseUrl || ''; $('#api-key').value = ''; $('#api-key').placeholder = state.model.hasKey ? 'Current key is set; leave blank to keep it' : 'Kept only in this running session'; $('#clear-key').checked = false;
  $('#endpoint-field').classList.toggle('hidden', $('#provider').value === 'anthropic'); $('#settings-dialog').showModal();
}

function requestText(title, label, action, button = 'Create') {
  state.textAction = action; $('#text-title').textContent = title; $('#text-label').firstChild.textContent = label; $('#text-input').value = ''; $('#text-submit').textContent = button; $('#text-dialog').showModal();
}

async function browse(path) {
  const result = await api(`browse?${new URLSearchParams({ path })}`);
  $('#workspace-path').value = result.path; $('#browse-parent').dataset.path = result.parent;
  $('#directory-list').innerHTML = result.directories.map(directory => `<button type="button" data-directory="${escape(directory.path)}">▱ ${escape(directory.name)}</button>`).join('') || '<p>No subfolders.</p>';
  $('#directory-list').querySelectorAll('[data-directory]').forEach(button => button.onclick = guard(() => browse(button.dataset.directory)));
}

$('#composer').addEventListener('submit', guard(async event => {
  event.preventDefault(); const message = $('#prompt').value.trim(); if (!message || state.jobId) return;
  if (!state.model.configured) { openSettings(); return; }
  const result = await post('chat', { message, images: state.image ? [state.image] : [] });
  state.jobId = result.jobId; $('#prompt').value = ''; setBusy(true);
  state.data.messages.push({ role: 'user', content: message, created_at: new Date().toISOString() }); renderMessages();
}));
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); } });
$('#stop-button').onclick = guard(async () => { if (state.jobId) await api('cancel', { id: state.jobId }); toast('Stopping the current operation…'); });
$('#model-button').onclick = openSettings;
$('#provider').onchange = () => $('#endpoint-field').classList.toggle('hidden', $('#provider').value === 'anthropic');
$('#settings-form').addEventListener('submit', guard(async event => { event.preventDefault(); state.model = await api('settings', { provider: $('#provider').value, model: $('#model-id').value.trim(), baseUrl: $('#endpoint').value.trim(), apiKey: $('#api-key').value, clearKey: $('#clear-key').checked }); $('#api-key').value = ''; $('#settings-dialog').close(); toast('Model connection saved for this session.'); }));
$('#open-workspace').onclick = () => { $('#workspace-path').value = state.data?.root || ''; $('#directory-list').innerHTML = ''; $('#workspace-dialog').showModal(); };
$('#workspace-form').addEventListener('submit', guard(async event => { event.preventDefault(); if (state.dirty && !confirm('Discard unsaved editor changes?')) return; const result = await api('workspaces', { path: $('#workspace-path').value.trim() }); state.selected = result.id; sessionStorage.setItem('vibekeep-workspace', result.id); state.file = null; state.content = null; state.dirty = false; state.data = null; $('#workspace-dialog').close(); await refreshWorkspace(); toast('Workspace connected.'); }));
$('#browse-button').onclick = guard(() => browse($('#workspace-path').value));
$('#browse-parent').onclick = guard(() => browse($('#browse-parent').dataset.path || $('#workspace-path').value));
$('#new-file').onclick = () => requestText('Create a resource', 'Relative file path', async path => { await post('file', { path, content: '', expectedHash: null }); await refreshWorkspace(); await selectFile(path); toggleSidebar(false); setView('inspector'); setTab('editor'); });
$('#experiment-button').onclick = () => requestText('Start an experiment', 'Experiment name', async name => { await post('experiment', { action: 'create', name }); await refreshWorkspace(); toast('Changes will be grouped in this experiment.'); });
$('#text-form').addEventListener('submit', guard(async event => { event.preventDefault(); await state.textAction($('#text-input').value.trim()); $('#text-dialog').close(); }));
$('#task-form').addEventListener('submit', guard(async event => {
  event.preventDefault(); const args = JSON.parse($('#task-args').value); const url = $('#task-url').value.trim();
  await post('tasks', { task: { id: $('#task-id').value.trim(), label: $('#task-label').value.trim(), command: $('#task-command').value.trim(), args, cwd: $('#task-cwd').value.trim() || '.', mode: $('#task-mode').value, ...(url ? { previewUrl: url } : {}) } });
  $('#task-dialog').close(); $('#task-form').reset(); await refreshWorkspace(); toast('Task registered.');
}));
$('#connect-application').onclick = () => { $('#workspace-dialog').close(); $('#connector-dialog').showModal(); };
$('#connector-form').addEventListener('submit', guard(async event => {
  event.preventDefault(); const result = await api('connectors', { endpoint: $('#connector-url').value.trim(), apiKey: $('#connector-key').value || undefined });
  $('#connector-key').value = ''; $('#connector-dialog').close(); state.selected = result.id; state.file = null; state.content = null; state.data = null; state.dirty = false;
  sessionStorage.setItem('vibekeep-workspace', result.id); await refreshWorkspace(); toast('Application workspace connected.');
}));
async function startTask(taskId, inputs) { const result = await post('run', { taskId, ...(inputs ? { inputs } : {}) }); state.jobId = result.jobId; setBusy(true); toast('Operation started.'); }
function openOperation(task) {
  state.operationTask = task;
  $('#operation-title').textContent = task.label; $('#operation-description').textContent = `${task.description || 'Run a registered application operation.'} Recovery: ${task.recovery || 'not specified'}.`;
  const properties = task.inputSchema.properties || {};
  const required = task.inputSchema.required || [];
  $('#operation-fields').innerHTML = Object.entries(properties).map(([name, schema]) => {
    const value = schema.default ?? (name === 'resourceId' ? state.file?.path || state.data.inventory.files[0]?.path || '' : name === 'expectedRevision' ? state.file?.hash || state.data.inventory.files[0]?.hash || '' : schema.type === 'number' || schema.type === 'integer' ? 0 : schema.type === 'object' ? '{}' : '');
    const control = schema.enum ? `<select data-operation-param="${escape(name)}">${schema.enum.map(option => `<option value="${escape(option)}">${escape(option)}</option>`).join('')}</select>`
      : schema.type === 'boolean' ? `<select data-operation-param="${escape(name)}"><option value="false">false</option><option value="true">true</option></select>`
      : `<input data-operation-param="${escape(name)}" type="${['number', 'integer'].includes(schema.type) ? 'number' : 'text'}" value="${escape(value)}" ${required.includes(name) ? 'required' : ''} placeholder="${escape(schema.description || name)}">`;
    return `<label>${escape(schema.title || name)}${control}</label>`;
  }).join('');
  $('#operation-dialog').showModal();
}
$('#operation-form').addEventListener('submit', guard(async event => {
  event.preventDefault(); const task = state.operationTask; const inputs = Object.create(null);
  $('#operation-fields').querySelectorAll('[data-operation-param]').forEach(input => { const name = input.dataset.operationParam; const type = task.inputSchema.properties[name].type; if (!input.value && !task.inputSchema.required?.includes(name)) return; inputs[name] = ['number', 'integer'].includes(type) ? Number(input.value) : type === 'boolean' ? input.value === 'true' : ['object', 'array'].includes(type) ? JSON.parse(input.value) : input.value; });
  await startTask(task.id, inputs); $('#operation-dialog').close();
}));
let integrationRequest = 0;
async function integrationConfig() {
  const request = ++integrationRequest;
  $('#copy-integration').disabled = true;
  $('#integration-config').textContent = '';
  const info = await post('integration', { client: $('#integration-client').value, writes: $('#integration-writes').checked, tasks: $('#integration-tasks').checked });
  if (request !== integrationRequest) return;
  $('#integration-config').textContent = info.config;
  $('#copy-integration').disabled = false;
}
$('#external-agent-button').onclick = guard(async () => { $('#workspace-menu').open = false; await integrationConfig(); $('#integration-dialog').showModal(); });
$('#integration-writes').onchange = guard(integrationConfig); $('#integration-tasks').onchange = guard(integrationConfig);
$('#integration-client').onchange = guard(integrationConfig);
$('#copy-integration').onclick = guard(async () => { await navigator.clipboard.writeText($('#integration-config').textContent); toast('Private session configuration copied.'); });
$('#attach-image').onclick = () => { if (!state.file || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(state.file.mediaType)) { toast('Select a PNG, JPEG, WebP, or GIF resource first.'); return; } state.image = state.file.path; renderAttachment(); };
$('#refresh-button').onclick = guard(async () => { $('#workspace-menu').open = false; await refreshWorkspace(true); toast('Workspace refreshed.'); });
$('#file-search').oninput = renderFiles;
$('#menu-button').onclick = () => toggleSidebar(!$('#sidebar').classList.contains('open'), true);
for (const button of views) button.onclick = () => { toggleSidebar(false); setView(button.dataset.view); };
for (const button of tabs) button.onclick = () => setTab(button.dataset.tab);
$('.inspector-tabs').addEventListener('keydown', event => {
  const index = tabs.indexOf(event.target);
  if (index < 0) return;
  let next;
  switch (event.key) {
    case 'ArrowRight': next = (index + 1) % tabs.length; break;
    case 'ArrowLeft': next = (index - 1 + tabs.length) % tabs.length; break;
    case 'Home': next = 0; break;
    case 'End': next = tabs.length - 1; break;
    default: return;
  }
  event.preventDefault();
  setTab(tabs[next].dataset.tab);
  tabs[next].focus({ preventScroll: true });
});
document.addEventListener('click', event => {
  if (!event.target.closest('#workspace-menu')) $('#workspace-menu').open = false;
  if (!event.target.closest('#sidebar, #menu-button, dialog')) toggleSidebar(false);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || $('dialog[open]')) return;
  if ($('#workspace-menu').open) {
    $('#workspace-menu').open = false;
    $('#workspace-menu summary').focus();
  } else if ($('#sidebar').classList.contains('open')) toggleSidebar(false, true);
});

document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
setInterval(() => { if (state.data && !state.jobId && !state.dirty && !document.activeElement?.closest('#panel :is(input, textarea, select)')) void refreshWorkspace().catch(() => {}); }, 8000);
renderPanel(); poll();
