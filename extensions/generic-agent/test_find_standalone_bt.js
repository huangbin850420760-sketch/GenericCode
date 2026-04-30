const fs = require('fs');
const path = require('path');

let parserSrc;
try {
    const self = path.join(__dirname, 'out', 'assistantParser.js');
    let src = fs.readFileSync(self, 'utf8');
    src = src.replace(/^"use strict";\s*\n/, '');
    src = src.replace(/Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);\s*\n/, '');
    src = src.replace(/exports\.([A-Za-z_$][\w$]*) = \1;\s*\n/g, '');
    src = src.replace(/\/\*[\s\S]*?\*\//g, '');
    src = src.replace(/^\s*\/\/.*$/gm, '');
    src = src.replace(/\s+\/\/.*$/gm, ' ');
    src = src.replace(/\n{3,}/g, '\n\n');
    parserSrc = src;
} catch(e) { console.log(e.message); process.exit(1); }

const chatPanelSrc = fs.readFileSync(path.join(__dirname, 'out', 'chatPanel.js'), 'utf8');
const htmlIdx = chatPanelSrc.indexOf('html() {');
const methodStart = chatPanelSrc.indexOf('{', htmlIdx) + 1;
let depth = 1, pos = methodStart;
while (pos < chatPanelSrc.length && depth > 0) {
    if (chatPanelSrc[pos] === '{') depth++;
    else if (chatPanelSrc[pos] === '}') depth--;
    pos++;
}
const methodBody = chatPanelSrc.substring(methodStart, pos - 1);

const getNonce = () => 'test-nonce-123';
const loadAssistantParserSource = () => parserSrc;
const htmlFn = new Function('getNonce', 'ChatPanel', methodBody);
const html = htmlFn(getNonce, { loadAssistantParserSource });

const scriptOpen = html.indexOf('<script nonce="');
const scriptTagEnd = html.indexOf('>', scriptOpen) + 1;
const scriptClose = html.indexOf('</script>', scriptTagEnd);
const scriptBlock = html.substring(scriptTagEnd, scriptClose);

// Use a proper JS tokenizer approach: walk through the script and
// track whether we're inside a string, regex, or template literal
// when we encounter each backtick.

let inSingleQuote = false;
let inDoubleQuote = false;
let inTemplate = false;
let inRegex = false;
let templateDepth = 0;

const standaloneBackticks = [];

for (let i = 0; i < scriptBlock.length; i++) {
    const ch = scriptBlock[i];
    const prev = i > 0 ? scriptBlock[i-1] : '';
    
    // Skip escaped characters
    if (prev === '\\') continue;
    
    if (inSingleQuote) {
        if (ch === "'") inSingleQuote = false;
        continue;
    }
    if (inDoubleQuote) {
        if (ch === '"') inDoubleQuote = false;
        continue;
    }
    if (inTemplate) {
        if (ch === '`') { 
            if (templateDepth === 0) inTemplate = false;
            else templateDepth--;
        }
        else if (ch === '$' && scriptBlock[i+1] === '{') {
            templateDepth++;
        }
        continue;
    }
    if (inRegex) {
        if (ch === '/') inRegex = false;
        continue;
    }
    
    // We're in "normal" code context
    if (ch === "'") { inSingleQuote = true; continue; }
    if (ch === '"') { inDoubleQuote = true; continue; }
    if (ch === '`') { 
        inTemplate = true; 
        standaloneBackticks.push(i);
        continue;
    }
    // Check for regex start: / followed by non-*/ (not a comment)
    // This is a heuristic - proper regex detection requires context
}

console.log('Standalone backticks (starting template literals):', standaloneBackticks.length);
for (const p of standaloneBackticks) {
    const ctx = scriptBlock.substring(Math.max(0, p - 30), Math.min(scriptBlock.length, p + 30));
    const lineNum = scriptBlock.substring(0, p).split('\n').length;
    console.log('  line ' + lineNum + ' at ' + p + ': ...' + ctx.replace(/\n/g, '\\n') + '...');
}
