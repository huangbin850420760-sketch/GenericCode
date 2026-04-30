#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');

const agentClientSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agentClient.ts'), 'utf8');
const chatPanelSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'chatPanel.ts'), 'utf8');

let failed = 0;
let total = 0;

function check(label, cond) {
	total++;
	if (cond) { console.log(`✓ ${label}`); }
	else {
		failed++;
		console.error(`✗ ${label}`);
	}
}

check('protocol version remains 1', /const EXT_PROTO_VERSION = 1;/.test(agentClientSrc));
check('handshake client id remains genericcode-ext', /client:\s*'genericcode-ext'/.test(agentClientSrc));
check('sendTask still emits task message', /sendTask\([\s\S]*?type:\s*'task'/.test(agentClientSrc));
check('task payload still includes text', /payload:\s*\{[\s\S]*?text,/.test(agentClientSrc));
check('task payload still includes files array', /payload:\s*\{[\s\S]*?files:\s*opts\?\.files \?\? \[\]/.test(agentClientSrc));
check('task payload still includes images array', /payload:\s*\{[\s\S]*?images:\s*opts\?\.images \?\? \[\]/.test(agentClientSrc));
check('abort message type unchanged', /sendAbort\(\): boolean \{[\s\S]*?type:\s*'abort'/.test(agentClientSrc));
check('reset message type unchanged', /sendReset\(\): boolean \{[\s\S]*?type:\s*'reset'/.test(agentClientSrc));
check('status request message type unchanged', /requestStatus\(\): boolean \{[\s\S]*?type:\s*'status'/.test(agentClientSrc));
check('feature set keeps context_push', /'context_push'/.test(agentClientSrc));
check('feature set keeps diff_preview', /'diff_preview'/.test(agentClientSrc));
check('feature set keeps show_diff', /'show_diff'/.test(agentClientSrc));

check('chat panel send path still resolves mentions to files', /const files = resolveMentionPaths\(msg\.mentions\);[\s\S]*?client\.sendTask\(msg\.text, \{ files \}\);/.test(chatPanelSrc));
check('chat panel reset still forwards reset to backend', /case 'reset':[\s\S]*?client\.sendReset\(\);[\s\S]*?this\.post\(\{ kind:\s*'reset' \}\);/.test(chatPanelSrc));
check('chat panel stream event shape unchanged', /this\.post\(\{ kind:\s*'stream', delta:\s*ev\.delta, full:\s*ev\.full \}\)/.test(chatPanelSrc));
check('chat panel done event shape unchanged', /this\.post\(\{ kind:\s*'done', payload \}\)/.test(chatPanelSrc));
check('chat panel status event shape unchanged', /this\.post\(\{ kind:\s*'status', status \}\)/.test(chatPanelSrc));

if (failed) {
	console.error(`\n${failed} / ${total} FAILED`);
	process.exit(1);
}

console.log(`\n${total} / ${total} passed`);
