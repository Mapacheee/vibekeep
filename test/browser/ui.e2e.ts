import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appFixture } from '../app-helper.js';
import { hash } from '../../src/paths.js';

test('real browser: design preview, source edits, memory, experiment recovery, agent tools, custom tasks, and responsive layout', { timeout: 120000 }, async t => {
  let root = ''; let call = 0;
  const model = createOpenAICompatible({ name: 'test', baseURL: 'https://mock.invalid/v1', fetch: async () => {
    call++;
    const invocation = call === 1 ? { name: 'read_file', arguments: JSON.stringify({ path: 'scene.svg' }) }
      : call === 2 ? { name: 'edit_svg', arguments: JSON.stringify({ path: 'scene.svg', nodeId: 'accent', attributes: { fill: '#d78755' }, expectedHash: hash(readFileSync(join(root, 'scene.svg'))) }) }
      : call === 3 ? { name: 'propose_decision', arguments: JSON.stringify({ statement: 'Use a warm accent for the card', area: 'design.color', evidenceQuote: 'warm accent' }) } : undefined;
    return new Response(JSON.stringify({ id: `mock-${call}`, object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: invocation ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${call}`, type: 'function', function: invocation }] } : { role: 'assistant', content: 'Updated the SVG accent and kept your preference as a proposal. The source change is recorded and can be undone.' }, finish_reason: invocation ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { headers: { 'Content-Type': 'application/json' } });
  } })('test');
  const fixture = appFixture(t, () => model); root = fixture.root;
  const original = readFileSync(resolve('examples/design/scene.svg'), 'utf8'); fixture.write('scene.svg', original);
  const url = await fixture.app.listen(0);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    await page.locator('[data-file="scene.svg"]').click();
    await page.locator('.preview-surface img').waitFor();
    assert.equal(await page.locator('.preview-surface img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), true);
    await page.locator('#tab-preview').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-editor').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#panel').getAttribute('aria-labelledby'), 'tab-editor');
    await page.keyboard.press('Home');
    const screenshotDirectory = process.env.VIBEKEEP_SCREENSHOT_DIR || resolve('../../work/browser-results');
    mkdirSync(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: join(screenshotDirectory, 'workspace-desktop.png'), fullPage: true });

    await page.locator('[data-tab="memory"]').click();
    await page.locator('#memory-statement').fill('Keep the layout spacious');
    await page.locator('#memory-form button').click();
    await page.locator('#panel').getByText('Keep the layout spacious', { exact: true }).waitFor();

    await page.locator('#experiment-button').click();
    await page.locator('#text-input').fill('Try another accent');
    await page.locator('#text-submit').click();
    await page.locator('#experiment-bar').waitFor({ state: 'visible' });
    await page.locator('[data-tab="preview"]').click();
    await page.locator('#svg-node').selectOption('accent');
    await page.locator('#svg-value').fill('#cc5522');
    await page.locator('#apply-svg').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent === 'Visual property updated.');
    assert.match(readFileSync(join(root, 'scene.svg'), 'utf8'), /#cc5522/);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#discard-experiment').click();
    await page.locator('#experiment-bar').waitFor({ state: 'hidden' });
    assert.equal(readFileSync(join(root, 'scene.svg'), 'utf8'), original);

    await page.locator('#prompt').fill('Use a warm accent for this design');
    await page.locator('#send-button').click();
    await page.getByText('Updated the SVG accent and kept your preference as a proposal.', { exact: false }).waitFor({ timeout: 25000 });
    assert.match(readFileSync(join(root, 'scene.svg'), 'utf8'), /#d78755/);
    await page.locator('[data-tab="memory"]').click();
    await page.locator('[data-accept]').click();
    await page.locator('[data-accept]').waitFor({ state: 'hidden' });

    await page.locator('[data-tab="tasks"]').click();
    await page.locator('#add-task').click();
    await page.locator('#task-id').fill('browser-check'); await page.locator('#task-label').fill('Browser test task');
    await page.locator('#task-command').fill(process.execPath); await page.locator('#task-args').fill(JSON.stringify(['-e', 'console.log("Browser task passed")']));
    await page.locator('#task-form button[type="submit"]').click();
    await page.locator('[data-run-task="custom:browser-check"]').click();
    await page.waitForFunction(() => !document.querySelector('#prompt')?.hasAttribute('disabled'), { timeout: 20000 });
    await page.locator('#show-checks').click(); await page.locator('#checks-results').getByText('Browser task passed', { exact: false }).waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('#menu-button').isVisible());
    await page.locator('#menu-button').click(); await page.locator('#sidebar.open').waitFor();
    await page.locator('[data-file="scene.svg"]').click();
    assert.equal(await page.locator('#menu-button').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.mobile-views [data-view="inspector"]').getAttribute('aria-pressed'), 'true');
    await page.locator('.preview-surface img').waitFor();
    await page.screenshot({ path: join(screenshotDirectory, 'workspace-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
