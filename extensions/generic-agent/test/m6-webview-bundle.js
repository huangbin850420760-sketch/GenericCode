#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * M6 webview-bundle smoke test: make sure the compiled chatPanel.js
 * actually inlines the assistantParser and ships the new render/toggle
 * pipeline.  These are cheap presence checks — they protect against
 * accidental removal during future refactors but DON'T assert runtime
 * behaviour (that's covered by m6-parser.js).
 */

const fs = require('fs');
const path = require('path');

const bundle = fs.readFileSync(path.join(__dirname, '..', 'out', 'chatPanel.js'), 'utf8');

let failed = 0, total = 0;
function check(label, cond) {
	total++;
	if (cond) { console.log(`✓ ${label}`); }
	else { console.error(`✗ ${label}`); failed++; }
}

// Loader helper — the function that reads assistantParser.js at runtime.
check('has loadAssistantParserSource', bundle.includes('loadAssistantParserSource'));
check('strips CJS __esModule preamble', bundle.includes('__esModule'));
check('strips exports.<name> lines',
	bundle.includes("exports.") && /replace\(.*exports/.test(bundle));

// Webview CSS / DOM pieces.
check('tool-card CSS present', bundle.includes('.tool-card'));
check('thinking-card CSS present', bundle.includes('.thinking-card'));
check('turn-divider CSS present', bundle.includes('.turn-divider'));
check('turn divider chevron CSS present', bundle.includes('.turn-divider .turn-chev'));
check('turn divider main-row CSS present', bundle.includes('.turn-divider .turn-main'));
check('turn divider meta-row CSS present', bundle.includes('.turn-divider .turn-meta'));
check('turn divider pill CSS present', bundle.includes('.turn-divider .turn-pill'));
check('turn divider preview CSS present', bundle.includes('.turn-divider .turn-preview'));
check('turn-block CSS present', bundle.includes('.turn-block'));
check('turn-block marker CSS present', bundle.includes('.turn-block::before'));
check('turn-block closed-state CSS present', bundle.includes('.turn-block[data-state="closed"]'));
check('assistant action bar CSS present', bundle.includes('.msg-actions'));
check('assistant summary CSS present', bundle.includes('.msg-summary'));
check('assistant pill CSS present', bundle.includes('.msg-pill'));
check('jump latest button CSS present', bundle.includes('#jump-latest'));
check('jump latest label text present', bundle.includes('Jump to latest'));
check('tool-badge CSS present', bundle.includes('.tool-badge'));
check('tool-meta CSS present', bundle.includes('.tool-meta'));
check('tool-spinner keyframe present', bundle.includes('@keyframes spin'));
check('data-state open rule', bundle.includes('[data-state="open"]'));
check('active card CSS present', bundle.includes('.tool-card.active'));

// Render pipeline.
check('renderAssistantBody function', bundle.includes('function renderAssistantBody'));
check('buildSegmentNode function', bundle.includes('function buildSegmentNode'));
check('desiredState function', bundle.includes('function desiredState'));
check('buildCardHead function', bundle.includes('function buildCardHead'));
check('getToolDisplay function', bundle.includes('function getToolDisplay'));
check('getThinkingDisplay function', bundle.includes('function getThinkingDisplay'));
check('assistant message actions helper present', bundle.includes('function buildAssistantActions'));
check('assistant summary helper present', bundle.includes('function summarizeAssistantSegments'));
check('turn summaries builder present', bundle.includes('function buildTurnSummaries'));
check('turn desired-state helper present', bundle.includes('function desiredTurnState'));
check('turn divider builder present', bundle.includes('function buildTurnDivider'));
check('assistant meta updater present', bundle.includes('function updateAssistantMeta'));
check('turn state setter present', bundle.includes('function setTurnState'));
check('turn toggle helper present', bundle.includes('function toggleTurnBlock'));
check('display-text helper present', bundle.includes('function getMessageDisplayText'));
check('insert reply helper present', bundle.includes('function insertReplyIntoComposer'));
check('quote reply helper present', bundle.includes('function quoteReplyIntoComposer'));
check('bulk card state helper present', bundle.includes('function setAssistantCardsState'));
check('retry payload helper present', bundle.includes('function getRetryPayload'));
check('unseen assistant counter helper present', bundle.includes('function markAssistantUpdateUnseen'));
check('sendChat helper present', bundle.includes('function sendChat'));
check('renderMarkdown still used for narrative', bundle.includes('renderMarkdown(seg.text)'));

// Toggle delegate.
check('turn toggle handler present', bundle.includes('data-turn-toggle'));
check('toggle event handler present', bundle.includes("data-seg-toggle"));
check('keyboard toggle handler present', bundle.includes("logEl.addEventListener('keydown'"));
check('aria-expanded toggle present', bundle.includes('aria-expanded'));
check('assistant message copy handler present', bundle.includes('data-msg-copy'));
check('assistant message copy-md handler present', bundle.includes('data-msg-copy-md'));
check('assistant message insert handler present', bundle.includes('data-msg-insert'));
check('assistant message quote handler present', bundle.includes('data-msg-quote'));
check('assistant message expand handler present', bundle.includes('data-msg-expand'));
check('assistant message collapse handler present', bundle.includes('data-msg-collapse'));
check('assistant message retry handler present', bundle.includes('data-msg-retry'));
check('segStates map referenced', bundle.includes('_segStates'));
check('segTouched set referenced', bundle.includes('_segTouched'));
check('toggleSegmentCard helper present', bundle.includes('function toggleSegmentCard'));

check('conditional autoscroll helper present', bundle.includes('function isNearBottom'));
check('scrollToBottom helper present', bundle.includes('function scrollToBottom'));
check('jump button refresh helper present', bundle.includes('function refreshJumpButton'));

// Stream handler uses the new render path, not plain renderMarkdown on full buffer.
check("stream handler uses renderAssistantBody",
	/case ['"]stream['"]:[\s\S]{0,400}renderAssistantBody/.test(bundle));
check("stream handler preserves user scroll position",
	/case ['"]stream['"]:[\s\S]{0,500}isNearBottom\(\)[\s\S]{0,500}scrollToBottom\(stick\)/.test(bundle));
check("done handler re-renders with isFinal=true",
	/case ['"]done['"]:[\s\S]{0,400}renderAssistantBody\([^,]+,\s*full,\s*true\)/.test(bundle));
check("done handler preserves user scroll position",
	/case ['"]done['"]:[\s\S]{0,500}isNearBottom\(\)[\s\S]{0,700}scrollToBottom\(stick\)/.test(bundle));
check("retry flow reuses send helper",
	/data-msg-retry[\s\S]{0,300}getRetryPayload[\s\S]{0,300}sendChat/.test(bundle));

if (failed) {
	console.error(`\n${failed} / ${total} FAILED`);
	process.exit(1);
}
console.log(`\n${total} / ${total} passed`);
